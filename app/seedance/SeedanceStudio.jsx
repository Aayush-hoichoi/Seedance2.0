'use client';

// Seedance 2.0 Studio — muapi house look: hero headline, a scrollable grid of
// generation jobs (running + finished, persisted across reloads), and a fixed
// bottom prompt-bar (PromptBar.jsx). Multiple generations can run in parallel;
// in-flight tasks are resumed after a reload by re-polling their ModelArk id.

import { useEffect, useMemo, useRef, useState } from 'react';
import { MODELS, MODES, RESOLUTIONS, DEFAULT_OPTIONS } from '../../lib/seedance/constants.js';
import { buildPayload, createTask, pollTask } from '../../lib/seedance/client.js';
import { validateAggregate, validateRequestSize } from '../../lib/seedance/limits.js';
import { buildTags, modeSupportsTags, normalizePromptForApi, validatePromptReferences } from '../../lib/seedance/tags.js';
import { registerAssetFromUrl } from '../../lib/seedance/assetsClient.js';
import { enhancePrompt } from '../../lib/seedance/enhance.js';
import { savePromptRecord, fetchPromptRecords } from '../../lib/seedance/promptsClient.js';
import { uploadToCdn } from '../../lib/seedance/upload.js';
import { validateMediaFile } from '../../lib/seedance/inspectMedia.js';
import { loadJobs, saveJobs, newJob, loadPrompts, savePrompt } from '../../lib/seedance/jobs.js';
import PromptBar from './PromptBar.jsx';

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
    const [enhancing, setEnhancing] = useState(false); // GPT-4o prompt restructuring in flight
    const [fullscreen, setFullscreen] = useState(null);
    const controllersRef = useRef({}); // jobId -> AbortController (not persisted)
    const pendingRef = useRef(0);

    const mode = useMemo(() => MODES.find((m) => m.id === modeId), [modeId]);
    const tags = useMemo(() => buildTags(mode, mediaByRole), [mode, mediaByRole]);
    const selectedModel = useMemo(() => MODELS.find((m) => m.id === options.model), [options.model]);
    const resolutions = useMemo(
        () => RESOLUTIONS.filter((r) => r !== '1080p' || selectedModel?.supports1080p),
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
        const prompts = loadPrompts();
        const localTaskIds = new Set(restored.map((j) => j.taskId).filter(Boolean));
        fetch('/api/byteplus/contents/generations/tasks?page_num=1&page_size=30')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                const items = Array.isArray(d?.items) ? d.items : [];
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
                        status: toJobStatus(t.status),
                        videoUrl: t.content?.video_url || null,
                        error: t.error?.message || null,
                        createdAt: (t.created_at || 0) * 1000,
                    }));
                    return [...refreshed, ...added].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
                });
                // Watch any server-side tasks still rendering that we didn't know about.
                for (const t of items) {
                    if (['queued', 'running'].includes(t.status) && !localTaskIds.has(t.id)) {
                        watchJob(`srv-${t.id}`, t.id);
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
    };

    // Drop a pending placeholder, upload the picked file to TOS, CreateAsset +
    // poll until Active, then swap in the asset:// item — role taken from the slot
    // so first_frame/last_frame stay correct. Auto-tags. Reports on failure.
    const registerInto = async (slot, { name, initialStatus, resolveUrl }) => {
        setError(null);
        const key = `pending-${pendingRef.current++}`;
        const placeholder = { kind: slot.kind, role: slot.role, url: '', name, isImage: slot.kind === 'image', pending: true, status: initialStatus, pendingKey: key };
        setMediaByRole((prev) => ({ ...prev, [slot.role]: [...(prev[slot.role] || []), placeholder].slice(0, slot.max) }));

        const patch = (fn) => setMediaByRole((prev) => ({ ...prev, [slot.role]: (prev[slot.role] || []).map((m) => (m.pendingKey === key ? fn(m) : m)) }));
        const drop = () => setMediaByRole((prev) => ({ ...prev, [slot.role]: (prev[slot.role] || []).filter((m) => m.pendingKey !== key) }));

        try {
            const url = await resolveUrl();
            const item = await registerAssetFromUrl({ url, kind: slot.kind, onStatus: (s) => patch((m) => ({ ...m, status: s })) });
            patch(() => ({ ...item, role: slot.role }));
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
                };
            }));
        });
    };

    // Create one job: submit the task, then watch it. Never blocks other jobs.
    // Quota/rate-limit rejections auto-retry with backoff instead of failing.
    // `promptMeta` (styled modes) carries the user's raw prompt + style for the
    // Neon prompt-pair store, powering the GPT-4o/user comparison tabs.
    const launchJob = async (payload, promptText, promptMeta = null) => {
        const job = newJob({ prompt: promptText, model: payload.model, userPrompt: promptMeta?.userPrompt ?? null, style: promptMeta?.style ?? null });
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

        // Styled modes (Motion Capture / Green Screen): GPT-4o restructures the
        // raw prompt into the full production brief before Seedance sees it.
        const promptMeta = mode.enhanceStyle ? { userPrompt: apiPrompt, style: mode.enhanceStyle } : null;
        if (mode.enhanceStyle) {
            setEnhancing(true);
            try {
                apiPrompt = await enhancePrompt({
                    style: mode.enhanceStyle,
                    prompt: apiPrompt,
                    assets: tags.map((t) => ({ label: t.label, kind: t.kind, name: t.name })),
                });
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

        // Fire `batch` parallel generations (seed -1 → each gets its own random seed).
        for (let i = 0; i < batch; i++) launchJob(payload, apiPrompt, promptMeta);
    };

    const onCancelJob = (id) => {
        controllersRef.current[id]?.abort();
        patchJob(id, { status: 'error', error: 'Cancelled.' });
    };

    const onRemoveJob = (id) => {
        controllersRef.current[id]?.abort();
        delete controllersRef.current[id];
        if (selectedId === id) setSelectedId(null);
        updateJobs((prev) => prev.filter((j) => j.id !== id));
    };

    const activeCount = jobs.filter((j) => ACTIVE_STATUSES.includes(j.status)).length;
    // What plays big in the center: only an explicitly selected job (set by a
    // rail click, a fresh Generate, or an in-flight resume) — never auto-play
    // old history after a reload.
    const selectedJob = jobs.find((j) => j.id === selectedId) || null;

    return (
        <div className="relative min-h-screen w-full bg-app-bg text-white">
            <div className="fixed top-5 left-6 z-30 text-xs font-medium tracking-wide text-white/40">
                Seedance 2.0 · <span className="text-white/25">BytePlus ModelArk</span>
                {activeCount > 0 && <span className="ml-2 text-primary/70">{activeCount} rendering…</span>}
            </div>

            {/* Center stage: hero when empty, else the selected job plays big.
                Finished generations live in the right-side history rail. */}
            <div className={`relative z-10 flex min-h-screen flex-col items-center justify-center px-4 pb-[24rem] sm:pb-56 pt-16 ${jobs.length > 0 ? 'sm:pr-52' : ''}`}>
                {!selectedJob ? (
                    <Hero />
                ) : (
                    <BigStage
                        key={selectedJob.id} /* remount on job switch → PromptTabs resets to the default tab */
                        job={selectedJob}
                        onCancel={() => onCancelJob(selectedJob.id)}
                        onFullscreen={() => selectedJob.videoUrl && setFullscreen(selectedJob.videoUrl)}
                    />
                )}
            </div>

            {jobs.length > 0 && (
                <HistoryRail
                    jobs={jobs}
                    selectedId={selectedJob?.id}
                    onSelect={setSelectedId}
                    onRemove={onRemoveJob}
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
                onGenerate={onGenerate}
                enhancing={enhancing}
                batch={batch}
                setBatch={setBatch}
                onMediaError={setError}
                onUploadFiles={onUploadFiles}
                tags={tags}
            />

            {fullscreen && <Fullscreen url={fullscreen} onClose={() => setFullscreen(null)} />}
        </div>
    );
}

// The selected generation, big in the center (higgsfield-style stage):
// video when done, live progress while rendering, error otherwise.
function BigStage({ job, onCancel, onFullscreen }) {
    const active = ACTIVE_STATUSES.includes(job.status);
    if (job.status === 'done' && job.videoUrl) {
        return (
            <div className="w-full max-w-3xl animate-fade-in-up">
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
                <PromptTabs job={job} />
            </div>
        );
    }
    if (active) {
        return (
            <div className="flex flex-col items-center justify-center text-center animate-fade-in-up">
                <IconTile pulse />
                <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight mb-3">{STATUS_TEXT[job.status] || 'Working…'}</h2>
                <p className="text-white/40 text-sm md:text-base max-w-md leading-relaxed">
                    Usually 1–5 minutes. It keeps rendering even if you reload — watch it land in the rail on the right.
                </p>
                {job.taskId && <p className="mt-3 text-[11px] text-white/20 break-all max-w-md">task {job.taskId}</p>}
                <button type="button" onClick={onCancel} className="mt-5 px-3 py-2 rounded-md text-xs font-semibold text-white/60 hover:text-white border border-white/10 hover:border-white/25 transition-colors">Cancel</button>
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

// Under a played video: the prompt actually sent to the model. In styled modes
// (Motion Capture / Green Screen) it's the GPT-4o-generated brief, shown next
// to a "Your prompt" tab for comparison; otherwise the plain one-line caption.
function PromptTabs({ job }) {
    const [tab, setTab] = useState('generated');
    const generated = job.prompt || '';
    const userPrompt = job.userPrompt || '';
    const hasBoth = !!userPrompt && !!generated && userPrompt !== generated;
    if (!hasBoth) {
        const single = generated || userPrompt;
        // Old generations restored from ModelArk have no prompt anywhere
        // (the list API never echoes it) — only their render settings.
        if (!single) {
            return <p className="mt-3 text-center text-xs text-white/35 truncate px-6" title={job.meta}>{job.meta}</p>;
        }
        return (
            <div className="mt-3">
                <div className="px-1 mb-1.5 text-[11px] font-semibold text-white/40">Prompt</div>
                <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 max-h-44 overflow-y-auto custom-scrollbar">
                    <p className="text-xs leading-relaxed text-white/60 whitespace-pre-wrap break-words">{single}</p>
                </div>
            </div>
        );
    }
    const tabs = [
        { id: 'generated', label: 'GPT-4o prompt (sent to model)', text: generated },
        { id: 'user', label: 'Your prompt', text: userPrompt },
    ];
    const current = tabs.find((t) => t.id === tab) || tabs[0];
    return (
        <div className="mt-3">
            <div className="flex items-center gap-1 mb-1.5 px-1">
                {tabs.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        onClick={() => setTab(t.id)}
                        className={`px-3 py-1.5 rounded-md text-[11px] font-semibold transition-colors ${t.id === current.id ? 'bg-primary/15 text-primary' : 'text-white/40 hover:text-white hover:bg-white/[0.06]'}`}
                    >{t.label}</button>
                ))}
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 max-h-44 overflow-y-auto custom-scrollbar">
                <p className="text-xs leading-relaxed text-white/60 whitespace-pre-wrap break-words">{current.text}</p>
            </div>
        </div>
    );
}

// Right-side history rail (higgsfield-style): every generation as a compact
// thumbnail — click to play it big on the center stage.
function HistoryRail({ jobs, selectedId, onSelect, onRemove }) {
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
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onRemove(job.id); }}
                                title="Remove from history"
                                aria-label="Remove"
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
