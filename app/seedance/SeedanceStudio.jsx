'use client';

// Seedance 2.0 Studio — muapi house look: hero headline, a scrollable grid of
// generation jobs (running + finished, persisted across reloads), and a fixed
// bottom prompt-bar (PromptBar.jsx). Multiple generations can run in parallel;
// in-flight tasks are resumed after a reload by re-polling their ModelArk id.

import { useEffect, useMemo, useRef, useState } from 'react';
import { MODELS, MODES, RATIOS, RESOLUTIONS, DEFAULT_OPTIONS } from '../../lib/seedance/constants.js';
import { sanitizeOptions } from '../../lib/seedance/options.mjs';
import { buildPayload, createTask, pollTask } from '../../lib/seedance/client.js';
import { validateAggregate, validateRequestSize } from '../../lib/seedance/limits.js';
import { buildTags, modeSupportsTags, normalizePromptForApi, restorePromptTokens, validatePromptReferences } from '../../lib/seedance/tags.js';
import { getAsset } from '../../lib/seedance/assetsClient.js';
import { enhancePrompt } from '../../lib/seedance/enhance.js';
import { savePromptRecord, fetchPromptRecords, setLikeRecord, setBinRecord, deletePromptRecord } from '../../lib/seedance/promptsClient.js';
import { uploadToCdn } from '../../lib/seedance/upload.js';
import { validateMediaFile } from '../../lib/seedance/inspectMedia.js';
import { loadJobs, saveJobs, newJob, loadPrompts, savePrompt, removePrompt } from '../../lib/seedance/jobs.js';
import PromptBar from './PromptBar.jsx';
import MediaHoverPreview from './MediaHoverPreview.jsx';
import AssetsPanel from './AssetsPanel.jsx';

// Resolve form state into the flat media list buildPayload expects, in the
// slot order the mode declares (so first_frame precedes last_frame).
function flattenMedia(mode, mediaByRole) {
    const out = [];
    for (const slot of mode.media) {
        for (const item of mediaByRole[slot.role] || []) out.push(item);
    }
    return out;
}

function validate(mode, prompt, mediaByRole) {
    if (mode.requiresText && !prompt.trim()) return 'Enter a prompt.';
    for (const slot of mode.media) {
        const n = (mediaByRole[slot.role] || []).length;
        if (n < slot.min) return `${slot.label}: add at least ${slot.min}.`;
    }
    if (mode.id === 'reference') {
        const imgs = (mediaByRole.reference_image || []).length;
        const vids = (mediaByRole.reference_video || []).length;
        if (imgs === 0 && vids === 0) return 'Reference mode needs at least one image or video.';
    }
    return null;
}

const STATUS_TEXT = { submitting: 'Submitting…', waiting: 'Waiting for a free slot…', queued: 'Queued…', running: 'Rendering…' };
const ACTIVE_STATUSES = ['submitting', 'waiting', 'queued', 'running'];
// Quota / rate-limit shaped errors → auto-retry instead of failing the card.
const RATE_LIMIT_RE = /rate.?limit|quota|too many|429|concurren|throttl/i;

export default function SeedanceStudio() {
    // Default to Motion Capture — the studio's headline styled mode; the
    // classic t2v/i2v/reference modes stay below it in the menu.
    const [modeId, setModeId] = useState('motion_capture');
    const [prompt, setPrompt] = useState('');
    const [options, setOptions] = useState(DEFAULT_OPTIONS);
    const [mediaByRole, setMediaByRole] = useState({});
    const [jobs, setJobs] = useState([]);
    const [batch, setBatch] = useState(1); // generations fired per Generate click
    const [selectedId, setSelectedId] = useState(null); // rail selection; null = follow newest
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null); // non-blocking info (e.g. GPT-4o refusal → raw-prompt fallback)
    const [enhancing, setEnhancing] = useState(false); // GPT-4o prompt restructuring in flight
    const [fullscreen, setFullscreen] = useState(null);
    const [showAssets, setShowAssets] = useState(false); // "All assets" overlay
    const controllersRef = useRef({}); // jobId -> AbortController (not persisted)
    const pendingRef = useRef(0);

    const mode = useMemo(() => MODES.find((m) => m.id === modeId), [modeId]);
    const tags = useMemo(() => buildTags(mode, mediaByRole), [mode, mediaByRole]);
    const selectedModel = useMemo(() => MODELS.find((m) => m.id === options.model), [options.model]);
    const resolutions = useMemo(
        () => RESOLUTIONS.filter((r) =>
            (r !== '1080p' || selectedModel?.supports1080p)
            && (r !== '4k' || selectedModel?.supports4k)),
        [selectedModel],
    );

    const setOpt = (k, v) => setOptions((o) => ({ ...o, [k]: v }));

    // Persist every jobs change; functional setter keeps concurrent pollers safe.
    const updateJobs = (fn) => setJobs((prev) => { const next = fn(prev); saveJobs(next); return next; });
    const patchJob = (id, patch) => updateJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));

    // Archive a finished video into the user's own TOS bucket so it outlives
    // ModelArk's ~24h links. Fire-and-forget — the original URL stays if it fails.
    const archiveJob = (jobId, taskId, url) => {
        fetch('/api/byteplus/archive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, taskId }),
        })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (d?.key && d?.url) patchJob(jobId, { videoUrl: d.url, archiveKey: d.key }); })
            .catch(() => {});
    };

    // Poll one task to its end and reflect progress on the job card.
    const watchJob = (jobId, taskId) => {
        const controller = new AbortController();
        controllersRef.current[jobId] = controller;
        pollTask(taskId, {
            onStatus: (s) => patchJob(jobId, { status: s === 'succeeded' ? 'running' : s }),
            signal: controller.signal,
        })
            .then(({ url }) => {
                patchJob(jobId, { status: 'done', videoUrl: url });
                archiveJob(jobId, taskId, url);
            })
            .catch((e) => patchJob(jobId, { status: 'error', error: e.message }))
            .finally(() => { delete controllersRef.current[jobId]; });
    };

    // On reload, restore history into the side rail and resume polling for
    // in-flight renders. The big stage auto-loads only an in-process render
    // (else the hero) — finished history plays big only when clicked in the rail.
    // History is SERVER-BACKED: recent tasks are fetched from ModelArk itself
    // and merged in, so the rail survives cleared localStorage / other browsers.
    useEffect(() => {
        const restored = loadJobs().map((j) =>
            ACTIVE_STATUSES.includes(j.status) && !j.taskId
                ? { ...j, status: 'error', error: 'Interrupted before the task was created.' }
                : j,
        );
        setJobs(restored);
        saveJobs(restored);
        const inFlight = restored.filter((j) => ACTIVE_STATUSES.includes(j.status) && j.taskId);
        for (const j of inFlight) watchJob(j.id, j.taskId);
        if (inFlight[0]) setSelectedId(inFlight[0].id);
        hydratePrompts(restored.filter((j) => !j.userPrompt).map((j) => j.taskId));

        // Archived videos live in the user's own TOS bucket forever — refresh
        // their presigned URLs (pure local signing on the server, instant).
        for (const j of restored) {
            if (j.archiveKey && j.status === 'done') {
                fetch(`/api/byteplus/archive?key=${encodeURIComponent(j.archiveKey)}`)
                    .then((r) => (r.ok ? r.json() : null))
                    .then((d) => { if (d?.url) patchJob(j.id, { videoUrl: d.url }); })
                    .catch(() => {});
            }
        }

        // Merge the account's recent generations from ModelArk (newest 30).
        // ModelArk lists EVERY task made with the API key (console, other
        // apps) — only merge tasks created from this platform, i.e. ones with
        // a Neon prompt record (written at creation) or a local prompt entry.
        // srv-* cards restored from localStorage are NOT trusted as proof of
        // origin: earlier sessions merged foreign tasks before this filter.
        const prompts = loadPrompts();
        const ownTaskIds = new Set(
            restored.filter((j) => !String(j.id).startsWith('srv-')).map((j) => j.taskId).filter(Boolean),
        );
        const localTaskIds = new Set(restored.map((j) => j.taskId).filter(Boolean));

        // Purge foreign cards that earlier sessions saved into localStorage.
        // Strict response check: on a Neon hiccup purge nothing, rather than
        // risk dropping legit platform cards made in other browsers.
        const suspects = restored.filter(
            (j) => String(j.id).startsWith('srv-') && j.taskId && !prompts[j.taskId] && !j.userPrompt,
        );
        if (suspects.length) {
            fetch(`/api/seedance/prompts?taskIds=${encodeURIComponent(suspects.map((j) => j.taskId).join(','))}`)
                .then((r) => (r.ok ? r.json() : null))
                .then((d) => {
                    if (!Array.isArray(d?.items)) return;
                    const known = new Set(d.items.map((row) => row.task_id));
                    const foreign = new Set(suspects.map((j) => j.taskId).filter((id) => !known.has(id)));
                    if (foreign.size) updateJobs((prev) => prev.filter((j) => !foreign.has(j.taskId)));
                })
                .catch(() => {});
        }

        fetch('/api/byteplus/contents/generations/tasks?page_num=1&page_size=30')
            .then((r) => (r.ok ? r.json() : null))
            .then(async (d) => {
                const all = Array.isArray(d?.items) ? d.items : [];
                if (!all.length) return;
                const unknownIds = all.map((t) => t.id).filter((id) => !ownTaskIds.has(id) && !prompts[id]);
                const records = await fetchPromptRecords(unknownIds);
                const items = all.filter((t) => ownTaskIds.has(t.id) || prompts[t.id] || records[t.id]);
                if (!items.length) return;
                const toJobStatus = (s) => (s === 'succeeded' ? 'done' : ['queued', 'running'].includes(s) ? s : 'error');
                updateJobs((prev) => {
                    const byTask = new Map(items.map((t) => [t.id, t]));
                    // Refresh local entries from server truth (renewed signed URLs etc.).
                    const refreshed = prev.map((j) => {
                        const t = j.taskId && byTask.get(j.taskId);
                        if (!t) return j;
                        if (t.status === 'succeeded') {
                            // Archived copies (user's own bucket) outlive ModelArk links — keep them.
                            const videoUrl = j.archiveKey ? j.videoUrl : (t.content?.video_url || j.videoUrl);
                            return { ...j, status: 'done', videoUrl };
                        }
                        return j;
                    });
                    const known = new Set(refreshed.map((j) => j.taskId).filter(Boolean));
                    const added = items.filter((t) => !known.has(t.id)).map((t) => ({
                        id: `srv-${t.id}`,
                        taskId: t.id,
                        prompt: prompts[t.id] || '', // recovered from the persistent prompt map
                        meta: [t.resolution, t.duration ? `${t.duration}s` : null, t.seed != null ? `seed ${t.seed}` : null].filter(Boolean).join(' · '),
                        model: t.model,
                        // Partial settings ModelArk's task list gives us — enough
                        // for Reuse to restore duration/resolution/seed/model
                        // (ratio/audio/watermark fall back to defaults).
                        options: { model: t.model, resolution: t.resolution, duration: t.duration, seed: t.seed },
                        status: toJobStatus(t.status),
                        videoUrl: t.content?.video_url || null,
                        error: t.error?.message || null,
                        createdAt: (t.created_at || 0) * 1000,
                        // Bin flag from Neon so a generation another user binned
                        // isn't briefly shown before hydratePrompts reconciles it.
                        deleted: !!records[t.id]?.deleted,
                        deletedAt: records[t.id]?.deleted ? (t.created_at || 0) * 1000 : null,
                    }));
                    return [...refreshed, ...added].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
                });
                // Watch any server-side tasks still rendering that we didn't
                // know about, and revive local cards a past network blip
                // marked as error while the task actually kept rendering.
                for (const t of items) {
                    if (!['queued', 'running'].includes(t.status)) continue;
                    if (!localTaskIds.has(t.id)) {
                        watchJob(`srv-${t.id}`, t.id);
                        continue;
                    }
                    const j = restored.find((x) => x.taskId === t.id);
                    if (j && j.status === 'error') {
                        patchJob(j.id, { status: t.status, error: null });
                        watchJob(j.id, t.id);
                    }
                }
                // Server-merged cards have no prompts — recover both from Neon.
                hydratePrompts(items.map((t) => t.id));
            })
            .catch(() => { /* offline / proxy down: local history still works */ });

        return () => { Object.values(controllersRef.current).forEach((c) => c.abort()); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const changeMode = (id) => {
        setModeId(id);
        setMediaByRole({});
        setError(null);
        setNotice(null);
    };

    // Drop a pending placeholder, upload the picked file to TOS, then swap in
    // the media item referencing the presigned TOS URL directly — role taken
    // from the slot so first_frame/last_frame stay correct. The ModelArk Asset
    // Library is deliberately NOT used (its entry tier caps out at 50 assets);
    // `tosKey` lets history refs re-presign the URL forever via /api/byteplus/archive.
    const registerInto = async (slot, { name, initialStatus, resolveUrl }) => {
        setError(null);
        const key = `pending-${pendingRef.current++}`;
        const placeholder = { kind: slot.kind, role: slot.role, url: '', name, isImage: slot.kind === 'image', pending: true, status: initialStatus, pendingKey: key };
        setMediaByRole((prev) => ({ ...prev, [slot.role]: [...(prev[slot.role] || []), placeholder].slice(0, slot.max) }));

        const patch = (fn) => setMediaByRole((prev) => ({ ...prev, [slot.role]: (prev[slot.role] || []).map((m) => (m.pendingKey === key ? fn(m) : m)) }));
        const drop = () => setMediaByRole((prev) => ({ ...prev, [slot.role]: (prev[slot.role] || []).filter((m) => m.pendingKey !== key) }));

        try {
            const up = await resolveUrl();
            patch(() => ({
                kind: slot.kind,
                role: slot.role,
                url: up.url,
                previewUrl: up.url,
                tosKey: up.key || null,
                name,
                isImage: slot.kind === 'image',
            }));
        } catch (e) {
            drop();
            setError(e.message);
        }
    };

    // Pick a local file → upload to TOS, then register that URL.
    const onUploadFile = (slot, file) =>
        registerInto(slot, { name: file.name, initialStatus: 'Uploading', resolveUrl: () => uploadToCdn(file) });

    // ONE picker for everything: route each selected file by its MIME type to the
    // mode's first open slot of that kind, validate against the Seedance limits,
    // then upload+register. Mirrors the ModelArk playground's "+ Image/Video/Audio".
    const onUploadFiles = async (fileList) => {
        const files = Array.from(fileList || []);
        if (!files.length) return;
        const used = Object.fromEntries(mode.media.map((s) => [s.role, (mediaByRole[s.role] || []).length]));
        for (const file of files) {
            const kind = file.type.startsWith('video/') ? 'video'
                : file.type.startsWith('audio/') ? 'audio'
                : file.type.startsWith('image/') ? 'image' : null;
            const slot = kind && mode.media.find((s) => s.kind === kind && used[s.role] < s.max);
            if (!slot) {
                setError(kind ? `No open ${kind} slot left for ${file.name}.` : `${file.name}: unsupported file type.`);
                continue;
            }
            const { error: invalid } = await validateMediaFile(kind, file);
            if (invalid) { setError(invalid); continue; }
            used[slot.role] += 1;
            onUploadFile(slot, file);
        }
    };

    // Backfill prompts for jobs restored without them (server-merged cards,
    // other browsers): the Neon store maps taskId → {user, generated} prompts.
    const hydratePrompts = (taskIds) => {
        const ids = [...new Set(taskIds.filter(Boolean))];
        if (!ids.length) return;
        fetchPromptRecords(ids).then((byTask) => {
            // Reverse-backfill: tasks created in THIS browser before the Neon
            // store existed still have their prompt in the local map — push
            // those up so other browsers recover them too.
            const localPrompts = loadPrompts();
            for (const id of ids) {
                if (!byTask[id] && localPrompts[id]) {
                    savePromptRecord({ taskId: id, userPrompt: localPrompts[id], generatedPrompt: null, style: null });
                }
            }
            if (!Object.keys(byTask).length) return;
            updateJobs((prev) => prev.map((j) => {
                const r = j.taskId && byTask[j.taskId];
                if (!r) return j;
                return {
                    ...j,
                    prompt: j.prompt || r.generated_prompt || r.user_prompt || '',
                    userPrompt: j.userPrompt || r.user_prompt || null,
                    style: j.style || r.style || null,
                    refs: j.refs || (Array.isArray(r.refs) && r.refs.length ? r.refs : null),
                    // Likes live in the DB — let server truth win so the mark
                    // follows the account across cleared storage and browsers.
                    liked: typeof r.liked === 'boolean' ? r.liked : !!j.liked,
                    // Bin state lives in the DB too — server truth wins so a
                    // generation binned in one browser is hidden in all of them.
                    deleted: typeof r.deleted === 'boolean' ? r.deleted : !!j.deleted,
                    deletedAt: typeof r.deleted === 'boolean'
                        ? (r.deleted ? (j.deletedAt || j.createdAt || null) : null)
                        : j.deletedAt,
                };
            }));
        });
    };

    // Create one job: submit the task, then watch it. Never blocks other jobs.
    // Quota/rate-limit rejections auto-retry with backoff instead of failing.
    // `promptMeta` (styled modes) carries the user's raw prompt + style for the
    // Neon prompt-pair store, powering the GPT-4o/user comparison tabs.
    // `creation` snapshots the mode + reference assets at click time, so the
    // history panel can show what was attached and Reuse can restore it.
    const launchJob = async (payload, promptText, promptMeta = null, creation = {}) => {
        const job = newJob({
            prompt: promptText,
            model: payload.model,
            userPrompt: promptMeta?.userPrompt ?? null,
            style: promptMeta?.style ?? null,
            modeId: creation.modeId ?? null,
            refs: creation.refs ?? null,
            options: creation.options ?? null,
        });
        updateJobs((prev) => [job, ...prev]);
        setSelectedId(job.id); // a fresh generation takes the big stage
        const MAX_ATTEMPTS = 6;
        const RETRY_DELAY_MS = 15000;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                const taskId = await createTask(payload);
                savePrompt(taskId, promptText); // survives any history wipe
                savePromptRecord({
                    taskId,
                    userPrompt: promptMeta?.userPrompt ?? promptText,
                    generatedPrompt: promptMeta ? promptText : null,
                    style: promptMeta?.style ?? null,
                    refs: creation.refs ?? null,
                });
                patchJob(job.id, { taskId, status: 'queued' });
                watchJob(job.id, taskId);
                return;
            } catch (e) {
                if (RATE_LIMIT_RE.test(e.message) && attempt < MAX_ATTEMPTS) {
                    patchJob(job.id, { status: 'waiting' });
                    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
                    continue;
                }
                patchJob(job.id, { status: 'error', error: e.message });
                return;
            }
        }
    };

    const onGenerate = async () => {
        if (enhancing) return;
        setError(null);
        setNotice(null);
        const problem = validate(mode, prompt, mediaByRole);
        if (problem) { setError(problem); return; }

        const mediaItems = flattenMedia(mode, mediaByRole);
        if (mediaItems.some((m) => m.pending)) { setError('Wait for reference assets to finish registering into your library.'); return; }
        const aggProblem = validateAggregate(mediaItems) || validateRequestSize(mediaItems);
        if (aggProblem) { setError(aggProblem); return; }

        // @Image1-style chips are auto-corrected to the "Image 1" wording the
        // API expects, then checked against what's actually attached.
        let apiPrompt = modeSupportsTags(mode) ? normalizePromptForApi(prompt) : prompt;
        if (modeSupportsTags(mode)) {
            const refProblem = validatePromptReferences(apiPrompt, tags);
            if (refProblem) { setError(refProblem); return; }
        }

        // Styled modes promise the source video's Bengali dialogue in the
        // output — impossible with audio generation off (silent video).
        if (mode.enhanceStyle && !options.generate_audio) {
            setError(`${mode.name} carries the source video's dialogue into the output — turn the Audio toggle on to generate.`);
            return;
        }

        // Styled modes (Motion Capture / Green Screen): GPT-4o restructures the
        // raw prompt into the full production brief before Seedance sees it. If
        // GPT-4o REFUSES the content, fall back to the user's own prompt and
        // send that straight to Seedance — never the refusal text.
        let promptMeta = mode.enhanceStyle ? { userPrompt: apiPrompt, style: mode.enhanceStyle } : null;
        if (mode.enhanceStyle) {
            setEnhancing(true);
            try {
                const result = await enhancePrompt({
                    style: mode.enhanceStyle,
                    prompt: apiPrompt,
                    assets: tags.map((t) => ({ label: t.label, kind: t.kind, name: t.name })),
                });
                if (result.refused) {
                    // Keep apiPrompt as the user's raw prompt; drop the styled meta
                    // so history shows a single plain prompt (no empty brief tab).
                    setNotice(result.reason || 'Prompt restructuring was declined — generating from your prompt as-is.');
                    promptMeta = null;
                } else {
                    apiPrompt = result.prompt;
                }
            } catch (e) {
                setError(e.message);
                return;
            } finally {
                setEnhancing(false);
            }
        }

        let payload;
        try {
            payload = buildPayload({ options, prompt: apiPrompt, mediaItems });
        } catch (e) {
            setError(e.message);
            return;
        }

        // Snapshot the attached reference assets (asset:// links live in the
        // BytePlus library, so they stay reusable from history; data: URLs
        // would bloat storage and are skipped). Powers the panel + Reuse.
        const refs = mediaItems
            .filter((m) => typeof m.url === 'string' && !m.url.startsWith('data:'))
            .map((m) => ({
                kind: m.kind,
                role: m.role,
                url: m.url,
                previewUrl: typeof m.previewUrl === 'string' && !m.previewUrl.startsWith('data:') ? m.previewUrl : null,
                name: m.name || null,
                assetId: m.assetId || null,
                tosKey: m.tosKey || null,
            }));
        // Snapshot the settings used for this generation so Reuse can restore
        // the full setup (duration, aspect ratio, resolution, audio, …).
        const creation = { modeId: mode.id, refs: refs.length ? refs : null, options: { ...options } };

        // Fire `batch` parallel generations (seed -1 → each gets its own random seed).
        for (let i = 0; i < batch; i++) launchJob(payload, apiPrompt, promptMeta, creation);
    };

    // "Reuse" on a history card: load that generation's reference assets AND
    // its prompt back into the prompt bar — restoring the mode it was made in,
    // so every ref lands in its original slot (clamped to the mode's per-slot
    // max). The raw user prompt wins over the GPT-4o brief: in styled modes the
    // brief is regenerated on the next Generate anyway.
    const onReuseRefs = (job, refs) => {
        const targetId = job.modeId || (MODES.some((m) => m.id === job.style) ? job.style : mode.id);
        const target = MODES.find((m) => m.id === targetId) || mode;
        const byRole = {};
        for (const r of refs) {
            if (!r?.url) continue; // unreusable (e.g. legacy entry without an asset link)
            const slot = target.media.find((s) => s.role === r.role && s.kind === r.kind);
            if (!slot) continue;
            const arr = byRole[r.role] || (byRole[r.role] = []);
            if (arr.length >= slot.max) continue;
            arr.push({
                kind: r.kind,
                role: r.role,
                url: r.url,
                previewUrl: r.previewUrl || null,
                name: r.name || '',
                isImage: r.kind === 'image',
                assetId: r.assetId || null,
                fromLibrary: true,
            });
        }
        setModeId(target.id);
        setMediaByRole(byRole);
        // Restore the generation settings (duration, aspect ratio, resolution,
        // audio, watermark, seed, model) this job was made with — sanitized
        // against the current catalog. Older jobs without a snapshot keep the
        // current settings (sanitizeOptions falls back to the live values).
        setOptions((cur) => sanitizeOptions(job.options, {
            defaults: cur,
            modelIds: MODELS.map((m) => m.id),
            ratios: RATIOS,
            resolutions: RESOLUTIONS,
            modelSupports1080p: (id) => !!MODELS.find((m) => m.id === id)?.supports1080p,
        }));
        // The stored prompt was normalised for the API ("@Video1" → "Video 1"),
        // so re-tokenise it against the restored refs to bring back the exact
        // "@Video1" wording the user typed (rendered as a chip in the bar).
        const raw = job.userPrompt || job.prompt || '';
        setPrompt(modeSupportsTags(target) ? restorePromptTokens(raw, buildTags(target, byRole)) : raw);
        setError(null);
    };

    const onCancelJob = (id) => {
        controllersRef.current[id]?.abort();
        patchJob(id, { status: 'error', error: 'Cancelled.' });
    };

    // The history-card cross moves a generation to the Bin (soft delete). It
    // stays in storage + Neon — just flagged `deleted` so it drops out of
    // history/assets — so the user can Restore it or delete it for good from
    // the Bin. We don't abort an in-flight render: it keeps going in the
    // background and shows up finished if restored.
    const onBinJob = async (id) => {
        const job = jobs.find((j) => j.id === id);
        if (selectedId === id) setSelectedId(null);
        patchJob(id, { deleted: true, deletedAt: Date.now() });
        // Persist the bin flag to Neon so the item stays hidden in EVERY browser.
        // Without this it was localStorage-only, so another user's reload
        // re-merged the task from ModelArk's list and showed it again.
        if (job?.taskId) {
            const ok = await setBinRecord({ taskId: job.taskId, deleted: true });
            if (!ok) setError('Moved to the bin here, but the server update failed — it may still appear in other browsers.');
        }
    };

    // Restore a binned generation back into history (locally + on the server).
    const onRestoreJob = async (id) => {
        const job = jobs.find((j) => j.id === id);
        patchJob(id, { deleted: false, deletedAt: null });
        if (job?.taskId) {
            const ok = await setBinRecord({ taskId: job.taskId, deleted: false });
            if (!ok) setError('Restored here, but the server update failed — it may still be binned in other browsers.');
        }
    };

    // Delete a generation for good (from the Bin). A generation persists in
    // THREE places, so a reload would otherwise resurrect it: the localStorage
    // job list, the local taskId→prompt map, and the Neon prompt record. Clear
    // all three (the ModelArk task list still returns the task, but the reload
    // merge only keeps tasks that have one of these local/Neon records). The
    // Neon delete is best-effort — on failure we warn it may return.
    const onDeleteForever = async (id) => {
        const job = jobs.find((j) => j.id === id);
        controllersRef.current[id]?.abort();
        delete controllersRef.current[id];
        if (selectedId === id) setSelectedId(null);
        updateJobs((prev) => prev.filter((j) => j.id !== id));
        if (job?.taskId) {
            removePrompt(job.taskId);
            const ok = await deletePromptRecord({ taskId: job.taskId });
            if (!ok) setError('Removed here, but the server delete failed — it may reappear on reload.');
        }
    };

    // Toggle the "like" mark on a history card. Optimistic: flip locally first
    // (instant + persisted in localStorage), then write the new state to Neon
    // keyed by taskId so it survives cleared storage and other browsers. If the
    // DB write fails, revert the flip and surface the error — the heart must
    // never claim a like the database didn't actually record.
    const onToggleLike = async (id) => {
        const job = jobs.find((j) => j.id === id);
        if (!job) return;
        const next = !job.liked;
        patchJob(id, { liked: next });
        if (!job.taskId) {
            // No server identity yet (still submitting) — can't persist a like.
            patchJob(id, { liked: job.liked });
            setError('You can like a generation once it has started rendering.');
            return;
        }
        const ok = await setLikeRecord({ taskId: job.taskId, liked: next });
        if (!ok) {
            patchJob(id, { liked: job.liked });
            setError('Could not save your like — check your connection and try again.');
        }
    };

    // Binned jobs stay in `jobs` (so they persist + can be restored) but are
    // hidden from every main view. The Bin tab in the Assets overlay shows them.
    const visibleJobs = jobs.filter((j) => !j.deleted);
    const binnedJobs = jobs.filter((j) => j.deleted);
    const activeCount = visibleJobs.filter((j) => ACTIVE_STATUSES.includes(j.status)).length;
    const doneCount = visibleJobs.filter((j) => j.status === 'done' && j.videoUrl).length;
    // What plays big in the center: only an explicitly selected job (set by a
    // rail click, a fresh Generate, or an in-flight resume) — never auto-play
    // old history after a reload. A binned job never plays on the stage.
    const selectedJob = jobs.find((j) => j.id === selectedId && !j.deleted) || null;

    return (
        <div className="relative min-h-screen w-full bg-app-bg text-white">
            <div className="fixed top-5 left-6 z-30 flex items-center gap-3 text-xs font-medium tracking-wide text-white/40">
                {selectedJob && (
                    <button
                        type="button"
                        onClick={() => setSelectedId(null)}
                        title="Back to the home screen"
                        className="flex items-center gap-1.5 px-2.5 py-1.5 -my-1.5 rounded-md border border-white/10 bg-white/[0.04] text-white/70 hover:text-white hover:border-white/25 hover:bg-white/[0.08] transition-colors"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
                        <span className="font-semibold">Home</span>
                    </button>
                )}
                <span>
                    Seedance 2.0 · <span className="text-white/25">BytePlus ModelArk</span>
                    {activeCount > 0 && <span className="ml-2 text-primary/70">{activeCount} rendering…</span>}
                </span>
            </div>

            {/* Top-right: open the "All assets" gallery (select many → download zip). */}
            <button
                type="button"
                onClick={() => setShowAssets(true)}
                title="Browse all your generated videos"
                className="fixed top-5 right-6 z-30 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-white/10 bg-white/[0.04] text-white/70 hover:text-white hover:border-white/25 hover:bg-white/[0.08] transition-colors text-xs font-semibold"
            >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
                <span>Assets</span>
                {doneCount > 0 && <span className="ml-0.5 text-white/35">{doneCount}</span>}
            </button>

            {/* Center stage: hero when empty, else the selected job plays big.
                Finished generations live in the right-side history rail. */}
            <div className={`relative z-10 flex min-h-screen flex-col items-center justify-center px-4 pb-[24rem] sm:pb-56 pt-16 ${visibleJobs.length > 0 ? 'sm:pr-52' : ''}`}>
                {!selectedJob ? (
                    <Hero />
                ) : (
                    <BigStage
                        key={selectedJob.id} /* remount on job switch → PromptTabs resets to the default tab */
                        job={selectedJob}
                        onCancel={() => onCancelJob(selectedJob.id)}
                        onFullscreen={() => selectedJob.videoUrl && setFullscreen(selectedJob.videoUrl)}
                        onReuse={onReuseRefs}
                    />
                )}
            </div>

            {visibleJobs.length > 0 && (
                <HistoryRail
                    jobs={visibleJobs}
                    selectedId={selectedJob?.id}
                    onSelect={setSelectedId}
                    onRemove={onBinJob}
                    onToggleLike={onToggleLike}
                />
            )}

            <PromptBar
                mode={mode}
                onChangeMode={changeMode}
                prompt={prompt}
                onPromptChange={setPrompt}
                options={options}
                setOpt={setOpt}
                mediaByRole={mediaByRole}
                setMediaByRole={setMediaByRole}
                models={MODELS}
                resolutions={resolutions}
                selectedModel={selectedModel}
                error={error}
                notice={notice}
                onGenerate={onGenerate}
                enhancing={enhancing}
                batch={batch}
                setBatch={setBatch}
                onMediaError={setError}
                onUploadFiles={onUploadFiles}
                tags={tags}
            />

            {fullscreen && <Fullscreen url={fullscreen} onClose={() => setFullscreen(null)} />}

            {showAssets && (
                <AssetsPanel
                    jobs={visibleJobs}
                    binned={binnedJobs}
                    onBin={onBinJob}
                    onRestore={onRestoreJob}
                    onDeleteForever={onDeleteForever}
                    onClose={() => setShowAssets(false)}
                />
            )}
        </div>
    );
}

// The selected generation, big in the center (higgsfield-style stage):
// video when done, live progress while rendering, error otherwise.
function BigStage({ job, onCancel, onFullscreen, onReuse }) {
    const active = ACTIVE_STATUSES.includes(job.status);
    if (job.status === 'done' && job.videoUrl) {
        const hasPrompt = !!(job.prompt || job.userPrompt || job.refs?.length);
        return (
            <div className={`w-full animate-fade-in-up ${hasPrompt ? 'max-w-6xl' : 'max-w-3xl'}`}>
                {/* Video left, prompt panel on the RIGHT (stacks below on small screens). */}
                <div className="flex flex-col lg:flex-row gap-4 justify-center lg:items-start">
                    <div className="flex-1 min-w-0 max-w-3xl mx-auto lg:mx-0">
                        <div className="relative rounded-2xl overflow-hidden border border-white/10 bg-black shadow-2xl">
                            <video key={job.id} src={job.videoUrl} controls autoPlay loop muted playsInline className="w-full max-h-[64vh] object-contain bg-black" />
                            <div className="absolute top-3 right-3 flex gap-2">
                                <button type="button" onClick={onFullscreen} title="Fullscreen" className="p-2 rounded-full bg-black/60 border border-white/10 text-white/80 hover:text-white hover:bg-black/80 transition-colors backdrop-blur-sm">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M16 21h3a2 2 0 002-2v-3M8 21H5a2 2 0 01-2-2v-3" /></svg>
                                </button>
                                <a href={job.videoUrl} download title="Download" className="p-2 rounded-full bg-black/60 border border-white/10 text-white/80 hover:text-primary hover:bg-black/80 transition-colors backdrop-blur-sm">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
                                </a>
                            </div>
                        </div>
                        {!hasPrompt && <p className="mt-3 text-center text-xs text-white/35 truncate px-6" title={job.meta}>{job.meta}</p>}
                    </div>
                    {hasPrompt && <PromptTabs job={job} onReuse={onReuse} />}
                </div>
            </div>
        );
    }
    if (active) {
        // Show the inputs alongside the spinner so the user can tell — at a
        // glance, and while it's still rendering — what prompt and which
        // reference assets this generation was started from.
        const hasPrompt = !!(job.prompt || job.userPrompt || job.refs?.length);
        const placeholder = (
            <div className="flex flex-col items-center justify-center text-center px-6">
                <IconTile pulse />
                <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight mb-3">{STATUS_TEXT[job.status] || 'Working…'}</h2>
                <p className="text-white/40 text-sm md:text-base max-w-md leading-relaxed">
                    Usually 1–5 minutes. It keeps rendering even if you reload — watch it land in the rail on the right.
                </p>
                {job.taskId && <p className="mt-3 text-[11px] text-white/20 break-all max-w-md">task {job.taskId}</p>}
                <button type="button" onClick={onCancel} className="mt-5 px-3 py-2 rounded-md text-xs font-semibold text-white/60 hover:text-white border border-white/10 hover:border-white/25 transition-colors">Cancel</button>
            </div>
        );
        if (!hasPrompt) return <div className="animate-fade-in-up">{placeholder}</div>;
        return (
            <div className="w-full max-w-6xl animate-fade-in-up">
                {/* Spinner left, the submitted prompt + reference assets on the
                    RIGHT — same layout the finished video uses. */}
                <div className="flex flex-col lg:flex-row gap-4 justify-center lg:items-start">
                    <div className="flex-1 min-w-0 max-w-3xl mx-auto lg:mx-0">
                        <div className="relative rounded-2xl overflow-hidden border border-white/10 bg-black/30 aspect-video flex items-center justify-center">
                            {placeholder}
                        </div>
                    </div>
                    <PromptTabs job={job} onReuse={onReuse} />
                </div>
            </div>
        );
    }
    return (
        <div className="max-w-md text-center animate-fade-in-up">
            <p className="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-300 leading-relaxed">{job.error || 'Generation failed.'}</p>
            <p className="mt-3 text-xs text-white/30 truncate" title={job.prompt}>{job.prompt}</p>
        </div>
    );
}

// Side panel to the RIGHT of a played video: the prompt actually sent to the
// model. In styled modes (Motion Capture / Green Screen) it's the GPT-4o brief,
// with a "Your prompt" tab for comparison; otherwise a single "Prompt" view.
// Below the prompt: the reference assets attached to this generation, with a
// Reuse button that loads them back into the prompt bar.
function PromptTabs({ job, onReuse }) {
    const [tab, setTab] = useState('generated');
    const generated = job.prompt || '';
    const userPrompt = job.userPrompt || '';
    const hasText = !!(generated || userPrompt);
    const hasBoth = !!userPrompt && !!generated && userPrompt !== generated;
    const tabs = hasBoth
        ? [
            { id: 'generated', label: 'GPT-4o prompt', text: generated },
            { id: 'user', label: 'Your prompt', text: userPrompt },
        ]
        : [{ id: 'generated', label: 'Prompt', text: generated || userPrompt }];
    const current = tabs.find((t) => t.id === tab) || tabs[0];
    return (
        <div className="w-full lg:w-80 xl:w-96 shrink-0 flex flex-col max-h-[40vh] lg:max-h-[64vh] rounded-2xl border border-white/10 bg-white/[0.02] backdrop-blur-sm overflow-hidden">
            {hasText && (
                <>
                    <div className="flex items-center gap-1 p-2 border-b border-white/[0.06] shrink-0">
                        {tabs.map((t) => (
                            <button
                                key={t.id}
                                type="button"
                                onClick={() => setTab(t.id)}
                                className={`px-3 py-1.5 rounded-md text-[11px] font-semibold transition-colors ${t.id === current.id ? 'bg-primary/15 text-primary' : 'text-white/40 hover:text-white hover:bg-white/[0.06]'}`}
                            >{t.label}</button>
                        ))}
                        {hasBoth && current.id === 'generated' && <span className="ml-auto pr-1 text-[9px] uppercase tracking-wider text-white/25">sent to model</span>}
                    </div>
                    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 py-3">
                        <p className="text-xs leading-relaxed text-white/60 whitespace-pre-wrap break-words">{current.text}</p>
                    </div>
                </>
            )}
            {job.refs?.length > 0 && <RefAssets refs={job.refs} onReuse={onReuse ? (items) => onReuse(job, items) : null} />}
        </div>
    );
}

// The reference assets a generation was made with (Video 1, Image 1, …), as
// thumbnails under the prompt panel. Signed preview links expire (~12h), so
// thumbs are refreshed — TOS uploads re-presign by key (pure local signing),
// legacy asset:// refs ask the asset library — and the same refreshed items
// are what Reuse hands back to the prompt bar.
function RefAssets({ refs, onReuse }) {
    const [items, setItems] = useState(refs);
    useEffect(() => {
        let alive = true;
        Promise.all(refs.map(async (r) => {
            try {
                if (r?.tosKey) {
                    const res = await fetch(`/api/byteplus/archive?key=${encodeURIComponent(r.tosKey)}`);
                    const d = res.ok ? await res.json() : null;
                    // Refresh url too — Reuse re-attaches it as the reference.
                    return d?.url ? { ...r, url: d.url, previewUrl: d.url } : r;
                }
                if (!r?.assetId) return r;
                const a = await getAsset(r.assetId);
                return a?.previewUrl ? { ...r, previewUrl: a.previewUrl } : r;
            } catch {
                return r; // expired/unreachable preview → kind icon fallback below
            }
        })).then((next) => { if (alive) setItems(next); });
        return () => { alive = false; };
    }, [refs]);

    // Positional tags in attachment order, matching the @Video1/@Image1 chips.
    const counters = {};
    const labeled = items.map((r) => {
        counters[r.kind] = (counters[r.kind] || 0) + 1;
        const kindName = r.kind === 'image' ? 'Image' : r.kind === 'video' ? 'Video' : 'Audio';
        return { ...r, tag: `${kindName} ${counters[r.kind]}` };
    });

    return (
        <div className="shrink-0 border-t border-white/[0.06] px-4 py-3">
            <div className="flex items-center justify-between pb-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-white/40">References · {labeled.length}</span>
                {onReuse && (
                    <button
                        type="button"
                        onClick={() => onReuse(items)}
                        title="Load these reference assets back into the prompt bar"
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide bg-primary/10 border border-primary/30 text-primary hover:bg-primary/20 transition-colors"
                    >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 4v6h6M23 20v-6h-6" /><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" /></svg>
                        Reuse
                    </button>
                )}
            </div>
            <div className="flex gap-2 flex-wrap">
                {labeled.map((r, i) => <RefThumb key={i} r={r} />)}
            </div>
        </div>
    );
}

// One reference thumbnail in the history panel. Hovering pops the same large
// floating preview the prompt bar uses (plays the video with its clip-length
// badge), so the user can see what asset went into the generation.
function RefThumb({ r }) {
    const [hover, setHover] = useState(false);
    const ref = useRef(null);
    const closeTimer = useRef(null);
    const isVid = r.kind === 'video';
    const canPreview = !!r.previewUrl && (r.kind === 'image' || isVid);
    // Keep the floating preview open while the cursor is on EITHER the thumb or
    // the preview itself (they sit apart, bridged by a body portal), so the
    // preview's download button is reachable. A short close delay spans the gap.
    const showPreview = () => { clearTimeout(closeTimer.current); setHover(true); };
    const hidePreview = () => { closeTimer.current = setTimeout(() => setHover(false), 140); };
    return (
        <div
            ref={ref}
            className="relative w-16 h-16 rounded-lg overflow-hidden border border-white/10 bg-black/40"
            title={r.name || r.tag}
            onMouseEnter={showPreview}
            onMouseLeave={hidePreview}
        >
            {hover && canPreview && <MediaHoverPreview anchor={ref.current} src={r.previewUrl} isVideo={isVid} tag={r.tag} name={r.name} onMouseEnter={showPreview} onMouseLeave={hidePreview} />}
            {r.kind === 'image' && r.previewUrl ? (
                <img src={r.previewUrl} alt={r.name || r.tag} className="w-full h-full object-cover" />
            ) : r.kind === 'video' && r.previewUrl ? (
                <video src={r.previewUrl} muted playsInline preload="metadata" className="w-full h-full object-cover bg-black" />
            ) : (
                <div className="w-full h-full flex items-center justify-center text-primary/70">
                    {r.kind === 'video' ? (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5" /></svg>
                    ) : r.kind === 'audio' ? (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
                    ) : (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>
                    )}
                </div>
            )}
            <span className="absolute bottom-0 inset-x-0 px-1 py-0.5 bg-black/75 text-[8px] font-black text-primary text-center truncate pointer-events-none">{r.tag}</span>
        </div>
    );
}

// Right-side history rail (higgsfield-style): every generation as a compact
// thumbnail — click to play it big on the center stage.
function HistoryRail({ jobs, selectedId, onSelect, onRemove, onToggleLike }) {
    return (
        <div className="fixed right-3 top-14 bottom-40 z-20 hidden sm:flex w-44 flex-col">
            <p className="px-1 pb-2 text-[10px] font-bold uppercase tracking-wider text-white/30">History · {jobs.length}</p>
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar flex flex-col gap-2 pr-0.5">
                {jobs.map((job) => {
                    const active = ACTIVE_STATUSES.includes(job.status);
                    const selected = job.id === selectedId;
                    return (
                        <div
                            key={job.id}
                            role="button"
                            tabIndex={0}
                            onClick={() => onSelect(job.id)}
                            onKeyDown={(e) => { if (e.key === 'Enter') onSelect(job.id); }}
                            title={job.prompt || job.meta || job.taskId}
                            className={`group relative shrink-0 aspect-video rounded-lg overflow-hidden border cursor-pointer transition-all ${selected ? 'border-primary/70 ring-1 ring-primary/40' : 'border-white/10 hover:border-white/30'}`}
                        >
                            {job.status === 'done' && job.videoUrl ? (
                                <video src={job.videoUrl} muted playsInline preload="metadata" className="w-full h-full object-cover bg-black" />
                            ) : (
                                <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-black/50 px-2 text-center">
                                    {active ? (
                                        <>
                                            <span className="animate-spin inline-block text-primary text-sm">◌</span>
                                            <span className="text-[9px] font-semibold text-white/50">{STATUS_TEXT[job.status]}</span>
                                        </>
                                    ) : (
                                        <span className="text-[9px] text-red-300 leading-tight line-clamp-3">{job.error || 'Failed'}</span>
                                    )}
                                </div>
                            )}
                            {/* Like mark — top-left, opposite the remove cross. Stays
                                lit once liked; otherwise reveals on hover like the X. */}
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onToggleLike(job.id); }}
                                title={job.liked ? 'Liked' : 'Like'}
                                aria-label={job.liked ? 'Unlike' : 'Like'}
                                aria-pressed={!!job.liked}
                                className={`absolute top-1 left-1 w-[18px] h-[18px] rounded-full bg-black/70 border flex items-center justify-center transition-all ${job.liked ? 'border-rose-400/40 text-rose-400 opacity-100' : 'border-white/20 text-white/60 hover:text-rose-300 opacity-0 group-hover:opacity-100'}`}
                            >
                                <svg width="10" height="10" viewBox="0 0 24 24" fill={job.liked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" /></svg>
                            </button>
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onRemove(job.id); }}
                                title="Move to bin"
                                aria-label="Move to bin"
                                className="absolute top-1 right-1 w-[18px] h-[18px] rounded-full bg-black/70 border border-white/20 text-white/60 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                            >
                                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            </button>
                        </div>
                    );
                })}
            </div>
            <p className="pt-2 px-1 text-[9px] leading-relaxed text-white/20">Saved on this device · links expire ~24h — download keepers</p>
        </div>
    );
}

// Glass icon tile with cyan camera glyph + sparkle — the muapi studio signature.
function IconTile({ pulse }) {
    return (
        <div className="mb-10 relative group">
            <div className={`absolute inset-0 bg-primary/10 blur-[120px] rounded-full transition-opacity duration-1000 ${pulse ? 'opacity-60 animate-pulse' : 'opacity-30 group-hover:opacity-60'}`} />
            <div className="relative w-24 h-24 md:w-32 md:h-32 bg-white/[0.02] rounded-[2rem] flex items-center justify-center border border-white/[0.05] overflow-hidden backdrop-blur-sm">
                <div className={`w-16 h-16 bg-primary/5 rounded-2xl flex items-center justify-center border border-primary/10 relative z-10 transition-transform duration-500 ${pulse ? 'animate-pulse' : 'group-hover:scale-110'}`}>
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-primary opacity-80">
                        <polygon points="23 7 16 12 23 17 23 7" />
                        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                    </svg>
                </div>
                <div className="absolute top-4 right-4 text-[10px] text-primary/40 animate-pulse">✨</div>
            </div>
        </div>
    );
}

function Hero() {
    return (
        <div className="flex flex-col items-center justify-center animate-fade-in-up">
            <IconTile />
            <h1 className="text-3xl sm:text-5xl md:text-6xl font-extrabold text-white tracking-tight mb-4 text-center px-4 leading-[1.05]">
                <span className="text-white/40 font-medium">START CREATING WITH</span><br />
                <span className="text-white">SEEDANCE 2.0</span>
            </h1>
            <p className="text-white/40 text-sm md:text-base font-medium tracking-wide text-center max-w-lg leading-relaxed">
                Turn text, images, or references into cinematic AI video — on your BytePlus ModelArk key.
            </p>
        </div>
    );
}

function Fullscreen({ url, onClose }) {
    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 backdrop-blur-sm animate-fade-in-up" onClick={onClose}>
            <button type="button" onClick={onClose} aria-label="Close" className="absolute top-6 right-6 p-3 bg-white/10 hover:bg-white/20 rounded-full border border-white/10 text-white transition-colors">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
            <video src={url} controls autoPlay loop className="max-w-[95vw] max-h-[95vh] rounded-2xl shadow-2xl object-contain" onClick={(e) => e.stopPropagation()} />
        </div>
    );
}
