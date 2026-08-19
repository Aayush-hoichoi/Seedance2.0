'use client';

// loglineAI Studio — muapi house look: hero headline, a scrollable grid of
// generation jobs (running + finished, persisted across reloads), and a fixed
// bottom prompt-bar (PromptBar.jsx). Multiple generations can run in parallel;
// in-flight tasks are resumed after a reload by re-polling their ModelArk id.

import { useEffect, useMemo, useRef, useState } from 'react';
import { MODELS, MODES, RATIOS, RESOLUTIONS, DEFAULT_OPTIONS, IMAGE_MODELS, IMAGE_DEFAULT_MODEL_ID, IMAGE_RATIOS, IMAGE_RESOLUTIONS, IMAGE_STUDIO_ID, IMAGE_STUDIO_MODEL_ID, modeAllowedForModel, resolutionWithinTier, imageRefMax, durationMaxFor } from '../../lib/seedance/constants.js';
import { sanitizeOptions } from '../../lib/seedance/options.mjs';
import { buildPayload, createTask, pollTask } from '../../lib/seedance/client.js';
import { validateAggregate, validateRequestSize } from '../../lib/seedance/limits.js';
import { buildTags, modeSupportsTags, normalizePromptForApi, restorePromptTokens, validatePromptReferences } from '../../lib/seedance/tags.js';
import { getAsset, resolveMediaRefs, cleanupOldAssets, registerAssetFromUrl } from '../../lib/seedance/assetsClient.js';
import { useEvents } from '../hooks/useEvents.js';
import { enhancePrompt } from '../../lib/seedance/enhance.js';
import { friendlyError } from '../../lib/seedance/friendlyError.js';
import { moveItem } from '../../lib/seedance/reorder.mjs';
import { mediaItemFromUpload } from '../../lib/seedance/mediaItem.mjs';
import { savePromptRecord, fetchPromptRecords, setLikeRecord, setBinRecord, deletePromptRecord } from '../../lib/seedance/promptsClient.js';
import { uploadToCdn } from '../../lib/seedance/upload.js';
import { validateMediaFile } from '../../lib/seedance/inspectMedia.js';
import { seedance25Constraints, editClipWarning } from '../../lib/seedance/constraints25.mjs';
import { fitImageToLimits } from '../../lib/seedance/downscaleImage.js';
import { loadJobs, saveJobs, newJob, loadPrompts, savePrompt, removePrompt } from '../../lib/seedance/jobs.js';
import { packSettings, unpackSettings, loadSettings, saveSettings } from '../../lib/seedance/settingsMemory.mjs';
import { archiveKeyForTask } from '../../lib/seedance/archiveKey.mjs';
import { resolveFreshVideoUrl } from '../../lib/seedance/videoUrl.js';
import { downloadAsset } from '../../lib/seedance/downloadAssets.js';
import PromptBar from './PromptBar.jsx';
import { UserButton } from '@clerk/nextjs';
import MediaHoverPreview from './MediaHoverPreview.jsx';
import ProjectSelect from './ProjectSelect.jsx';
import BudgetRemaining from './BudgetRemaining.jsx';
import MySpend from './MySpend.jsx';
import BudgetRequestModal from './BudgetRequestModal.jsx';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck, WalletCards } from 'lucide-react';
import AssetsPanel from './AssetsPanel.jsx';
import CinematicPanel from './CinematicPanel.jsx';
import { cinematicToPayload, sanitizeSetup, DEFAULT_SETUP } from '../../lib/seedance/cinematic.mjs';

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

// Downscale a reference image for INLINE delivery to Gemini: longest side to
// ~1024px, JPEG — keeps three refs well under the /api/generations body cap.
// Returns { mimeType, b64, previewUrl } (previewUrl is the same data: URL).
async function downscaleForInline(file, maxDim = 1024) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const m = /^data:(.*?);base64,(.*)$/.exec(dataUrl);
    if (!m) throw new Error('encode failed');
    return { mimeType: m[1], b64: m[2], previewUrl: dataUrl };
}
// Quota / rate-limit shaped errors → auto-retry instead of failing the card.
const RATE_LIMIT_RE = /rate.?limit|quota|too many|429|concurren|throttl/i;
// A reused ref (history or Community Gallery "Reuse") can carry an `asset://`
// id that per-batch cleanup has since deleted — sending it to ModelArk yields
// "The specified asset ... is not found". If the ref still has its TOS source
// key, re-presign the original file so the submit pre-flight registers a FRESH,
// live asset. asset:// refs WITHOUT a tosKey are live library picks (never
// auto-deleted) and pass through untouched. Returns a NEW array.
async function rehydrateStaleAssetRefs(items) {
    return Promise.all(items.map(async (m) => {
        if (typeof m?.url !== 'string' || !m.url.startsWith('asset://') || !m.tosKey) return m;
        try {
            const res = await fetch(`/api/byteplus/archive?key=${encodeURIComponent(m.tosKey)}`);
            const d = res.ok ? await res.json() : null;
            if (!d?.url) return m; // can't re-source → keep asset:// (it may still be alive)
            const { assetId, ...rest } = m; // drop the stale id; pre-flight re-registers
            return { ...rest, url: d.url };
        } catch {
            return m;
        }
    }));
}
// A done job whose only link is the ~24h ModelArk task URL is refreshed
// proactively once it's ~20h old — players skip a stale URL entirely instead
// of paying for the slow network failure first. URL age = last refresh, else
// job creation (a refresh hands out a brand-new signed link).
const STALE_URL_MS = 20 * 60 * 60 * 1000;
const isStaleUrl = (job) => !job.archiveKey
    && Date.now() - (job.urlRefreshedAt || job.createdAt || 0) > STALE_URL_MS;

export default function SeedanceStudio() {
    // Default to Motion Capture — the studio's headline styled mode; the
    // classic t2v/i2v/reference modes stay below it in the menu.
    const [modeId, setModeId] = useState('motion_capture');
    const [prompt, setPrompt] = useState('');
    const [options, setOptions] = useState(DEFAULT_OPTIONS);
    const [mediaByRole, setMediaByRole] = useState({});
    const [jobs, setJobs] = useState([]);
    const [batch, setBatch] = useState(1); // generations fired per Generate click
    const [mediaType, setMediaType] = useState('video'); // 'video' (Seedance) | 'image' (Nano Banana)
    const [imageRefs, setImageRefs] = useState([]); // Image-mode reference images (base64 inline parts for Gemini)
    const [cinematic, setCinematic] = useState(null); // active Cinematic Cameras setup (image mode) or null = off
    const [showCinematic, setShowCinematic] = useState(false); // the cinematic camera modal
    const [selectedId, setSelectedId] = useState(null); // rail selection; null = follow newest
    const autoSelectedRef = useRef(false); // one auto-pick per project; reset on project switch
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null); // non-blocking info (e.g. the enhancer refusal → raw-prompt fallback)
    const [enhancing, setEnhancing] = useState(false); // the enhancer prompt restructuring in flight
    const [fullscreen, setFullscreen] = useState(null);
    const [showAssets, setShowAssets] = useState(false); // "All assets" overlay
    // The remembered settings have been applied — until they are, saving would
    // overwrite the user's setup with this mount's defaults.
    const [settingsReady, setSettingsReady] = useState(false);
    const controllersRef = useRef({}); // jobId -> AbortController (not persisted)
    const pendingRef = useRef(0);

    // Which models this user may use (Mini/Fast always; gated 2.0 only if granted).
    // null = still loading; then string[]. Gated models the user lacks are locked
    // in the picker with a "request access" action.
    const [allowedModelIds, setAllowedModelIds] = useState(null);
    // Video `kind`s present in the ACTIVE gateway catalog — allowed or not. The
    // picker renders from the constants list, so without this a model that is
    // seeded but deactivated (a tier awaiting activation at the provider) would
    // still show as a locked row and collect access requests it cannot honour.
    // null = catalog unknown (pre-migration / fetch failed) → show everything,
    // which is the behaviour that predates this filter.
    const [catalogVideoKinds, setCatalogVideoKinds] = useState(null);
    // Per-model quality cap from the grant ('4k', '2K', …); absent/null = the
    // model's full range. Keys are studio model ids (video tags + image aliases).
    const [tierCaps, setTierCaps] = useState({});
    // Raw access requests (from /api/access/me) — feeds the "requested" label
    // on locked tiers when a quality upgrade is already parked with the admin.
    const [accessRequests, setAccessRequests] = useState([]);
    const [isAdmin, setIsAdmin] = useState(false); // shows the /admin shortcut (server still enforces)
    // (There was a monthSpend state here for "the badge" that was set and never
    // read. The badge now exists — MySpend — but shows spend on the CURRENT
    // PROJECT, not this user's workspace-wide month, so it reconciles with the
    // project total beside it. /api/access/me still returns monthSpendUsd for
    // the MCP catalog tool.)
    // Gateway projects: model access + budgets are scoped per project. The
    // picker only appears when the user belongs to more than one.
    const [projects, setProjects] = useState([]);
    const [projectId, setProjectId] = useState(null);
    const [projectsLoaded, setProjectsLoaded] = useState(false); // false → don't render the rail yet
    const [canManageProjects, setCanManageProjects] = useState(false); // admins/managers may create projects
    const [permsVersion, setPermsVersion] = useState(0); // bump → refetch access
    const [budgetVersion, setBudgetVersion] = useState(0); // settlement/release → refresh remaining balance
    const [budgetRequestOpen, setBudgetRequestOpen] = useState(false);

    useEffect(() => {
        let alive = true;
        fetch('/api/access/me')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (alive && d) { setAllowedModelIds(d.allowedModelIds); setIsAdmin(!!d.isAdmin); if (Array.isArray(d.requests)) setAccessRequests(d.requests); } })
            .catch(() => {});
        fetch('/api/projects')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                if (!alive) return;
                setCanManageProjects(!!d?.canManageProjects);
                if (Array.isArray(d?.items) && d.items.length) {
                    setProjects(d.items);
                    // /projects deep-links with ?project=; that beats the stored last choice.
                    const fromUrl = Number(new URLSearchParams(window.location.search).get('project')) || null;
                    const wanted = [fromUrl, Number(localStorage.getItem('seedance:project')) || null]
                        .find((id) => id && d.items.some((p) => p.id === id));
                    const chosen = wanted ?? d.items[0].id;
                    setProjectId(chosen);
                    try { localStorage.setItem('seedance:project', String(chosen)); } catch { /* private mode */ }
                }
                setProjectsLoaded(true); // gate the history rail until the project is known
            })
            .catch(() => { if (alive) setProjectsLoaded(true); });
        return () => { alive = false; };
    }, []);

    // The spend on the project chip is captured at mount, so it would sit
    // frozen while the user kept generating. Refresh it on the same signal the
    // budget badge uses (settlement/release). Only the AMOUNTS are merged in:
    // re-running the mount effect above would redo project SELECTION (?project=
    // / localStorage) and could yank someone into a different project
    // mid-session. New objects, no mutation.
    useEffect(() => {
        if (!budgetVersion) return undefined; // mount already fetched these
        let alive = true;
        fetch('/api/projects')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                if (!alive || !Array.isArray(d?.items)) return;
                const spendById = new Map(d.items.map((p) => [p.id, p]));
                setProjects((prev) => prev.map((p) => {
                    const fresh = spendById.get(p.id);
                    // Both figures move together — refreshing one without the
                    // other would briefly show a personal spend above the
                    // project's.
                    return fresh ? { ...p, spent_usd: fresh.spent_usd, my_spent_usd: fresh.my_spent_usd } : p;
                }));
            })
            .catch(() => { /* a stale figure beats a broken header */ });
        return () => { alive = false; };
    }, [budgetVersion]);

    // Per-project effective model list (precedence-aware). Falls back to the
    // /api/access/me answer above when the gateway isn't migrated yet.
    useEffect(() => {
        if (!projectId) return;
        let alive = true;
        fetch(`/api/models?projectId=${projectId}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                if (!alive || !Array.isArray(d?.items)) return;
                // Video picker keys by provider tag (MODELS[].id), so bridge via
                // kind; image picker keys by the alias, which IS the item id — so
                // add allowed image ids directly. Both must be present or the
                // image picker can't tell Nano Banana Pro is unlocked.
                const allowed = d.items.filter((m) => m.allowed);
                const allowedKinds = new Set(allowed.map((m) => m.kind));
                // Every active video kind, regardless of grant — drives which
                // rows the picker offers at all (see catalogVideoKinds).
                const videoKinds = d.items.filter((m) => m.category === 'video' && m.kind).map((m) => m.kind);
                setCatalogVideoKinds(videoKinds.length ? new Set(videoKinds) : null);
                const videoIds = MODELS.filter((m) => allowedKinds.has(m.kind)).map((m) => m.id);
                const imageIds = allowed.filter((m) => m.category === 'image').map((m) => m.id);
                setAllowedModelIds([...videoIds, ...imageIds]);
                // Quality caps ride the same payload; bridge video via kind
                // (same mapping as above), image keys are the item id already.
                const caps = {};
                for (const m of allowed) {
                    if (m.maxResolution == null) continue;
                    if (m.category === 'image') caps[m.id] = m.maxResolution;
                    else MODELS.filter((x) => x.kind === m.kind).forEach((x) => { caps[x.id] = m.maxResolution; });
                }
                setTierCaps(caps);
            })
            .catch(() => {});
        return () => { alive = false; };
    }, [projectId, permsVersion]);

    // A locked model must never stay the active selection — when access lapses
    // (revoke/expiry) or a persisted choice isn't granted here, fall back to the
    // first available model of the current type. Locked models still appear in
    // the picker (to request), just never selected. Cinematic Studio owns its
    // own toggle, so leave it alone.
    useEffect(() => {
        if (!allowedModelIds) return;
        const list = mediaType === 'image' ? IMAGE_MODELS : MODELS;
        if (mediaType === 'image' && options.imageStudio) return;
        const cur = list.find((m) => m.id === options.model);
        const locked = cur?.gated && !allowedModelIds.includes(options.model);
        if (!locked) return;
        const avail = list.find((m) => !m.gated || allowedModelIds.includes(m.id));
        if (avail && avail.id !== options.model) setOpt('model', avail.id);
    }, [allowedModelIds, mediaType, options.model, options.imageStudio]); // eslint-disable-line react-hooks/exhaustive-deps

    // Live governance: revokes/expiries flip the picker instantly; budget
    // alerts surface as the studio's notice banner.
    useEvents('*', ({ type, data }) => {
        if (type === 'access.revoked' || type === 'access.expired' || type === 'access.granted') {
            setPermsVersion((v) => v + 1);
            if (type !== 'access.granted') setNotice(`Model access changed: ${data?.modelId || ''} was ${type === 'access.expired' ? 'auto-expired' : 'revoked'}.`);
        }
        if (type === 'budget.threshold_crossed') {
            setNotice(`Budget alert — ${data?.threshold}% of the ${data?.window} ${data?.type} limit is used.`);
        }
        if (type === 'budget.request.approved') {
            setBudgetVersion((v) => v + 1);
            setPermsVersion((v) => v + 1);
            // An admin can approve a different amount than was asked for, so say
            // what was actually granted — otherwise a partial approval reads as
            // a silent shortfall the next time a generation is blocked.
            const granted = Number(data?.approvedIncrease);
            const asked = Number(data?.requestedIncrease);
            const adjusted = Number.isFinite(granted) && Number.isFinite(asked) && granted !== asked
                ? ` — $${granted.toFixed(2)} of the $${asked.toFixed(2)} you requested`
                : '';
            setNotice(`Budget approved for ${data?.modelName || 'your requested models'}${adjusted} — hard limit $${Number(data?.hardLimit || 0).toFixed(2)}.`);
        }
        if (type === 'budget.request.denied') {
            setNotice(`Budget request denied for ${data?.modelName || 'the requested models'}${data?.reason ? ` — ${data.reason}` : '.'}`);
        }
        if (type === 'access.request.denied') {
            setNotice(`Access request ${data?.upgradeDeclined ? 'for a higher quality tier ' : ''}denied for ${data?.modelId || 'the requested model'}${data?.reason ? ` — ${data.reason}` : '.'}`);
        }
        if (type === 'job.status_changed' && ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(data?.status)) {
            setBudgetVersion((v) => v + 1);
        }
        if (type === 'project.paused') setNotice('This project was paused by an admin — new generations are held.');
    });

    const selectProject = (id) => {
        setProjectId(id);
        // The big stage follows the rail, which is project-scoped — so switching
        // projects must drop the old project's selection and let the new
        // project auto-pick its own latest (else a render from the old project
        // would keep playing on the stage here).
        setSelectedId(null);
        autoSelectedRef.current = false;
        try { localStorage.setItem('seedance:project', String(id)); } catch { /* private mode */ }
    };

    // One-time backfill: history created before project tagging has no
    // projectId. All of it predates project separation (single Default
    // project), so stamp it onto the home project (the oldest — projects[0]).
    useEffect(() => {
        if (!projects.length) return;
        const home = projects[0].id;
        setJobs((prev) => {
            if (!prev.some((j) => j.projectId == null)) return prev;
            const next = prev.map((j) => (j.projectId == null ? { ...j, projectId: home } : j));
            saveJobs(next);
            return next;
        });
    }, [projects]);

    // The active project as an object (id + name), for routing reference
    // assets into that project's own BytePlus group. null when no project.
    const activeProject = useMemo(
        () => (projectId ? (projects.find((p) => p.id === projectId) || { id: projectId }) : null),
        [projectId, projects],
    );

    // Sweep leaked studio assets (1h+, from closed or pre-update tabs) from
    // ALL studio groups so the tiny shared (account-wide) BytePlus pool never
    // fills up — stale assets in other projects' groups count against the
    // same pool and broke uploads before. Re-sweep every 30 min: a studio tab
    // left open for days never remounts, and mount-only sweeping let the pool
    // silently refill.
    //
    // No longer the only cleanup path: this runs only while a tab is OPEN, so
    // it never collected anything registered by MCP or left by a closed tab.
    // The server now sweeps too (on CreateAsset, throttled, plus the daily
    // cron). Kept because it is the most timely one for an active session.
    useEffect(() => {
        if (!projectId) return;
        cleanupOldAssets().catch(() => {});
        const timer = setInterval(() => cleanupOldAssets().catch(() => {}), 30 * 60 * 1000);
        return () => clearInterval(timer);
    }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

    const mode = useMemo(() => MODES.find((m) => m.id === modeId), [modeId]);
    const tags = useMemo(() => buildTags(mode, mediaByRole), [mode, mediaByRole]);
    const selectedModel = useMemo(() => MODELS.find((m) => m.id === options.model), [options.model]);
    // A deactivated catalog entry disappears from the picker entirely rather
    // than showing as locked: `active` is the switch, and flipping it in the DB
    // brings the tier back with no deploy.
    const visibleVideoModels = useMemo(
        () => (catalogVideoKinds ? MODELS.filter((m) => catalogVideoKinds.has(m.kind)) : MODELS),
        [catalogVideoKinds],
    );
    // Capability-only list: tiers above the user's granted cap stay VISIBLE in
    // the picker (locked, with an upgrade-request affordance in PromptBar) —
    // the clamp below keeps them from ever being the active selection.
    const resolutions = useMemo(
        () => RESOLUTIONS.filter((r) =>
            (r !== '1080p' || selectedModel?.supports1080p)
            && (r !== '4k' || selectedModel?.supports4k)),
        [selectedModel],
    );

    // Seedance 2.5 task-type lock: with a video attached (any mode) the task
    // may run as an edit/extension, and first-frame modes always follow the
    // image — both only accept adaptive ratio (edits also demand Auto
    // duration). Computed here, enforced by the clamp effect below and shown
    // as disabled options in the PromptBar pills.
    const hasVideoInput = useMemo(
        () => mode.media.some((s) => s.kind === 'video' && (mediaByRole[s.role] || []).length > 0),
        [mode, mediaByRole],
    );
    const lock25 = useMemo(
        () => seedance25Constraints({
            modelKind: selectedModel?.kind,
            hasVideoInput,
            hasFirstFrame: mode.media.some((s) => s.role === 'first_frame'),
        }),
        [selectedModel, mode, hasVideoInput],
    );

    // Attaching a video (or switching model/mode) can strand a ratio/duration
    // the locked task type rejects — snap them to the required values so the
    // request that leaves this app can never trip TaskTypeConstraint.
    useEffect(() => {
        if (!lock25) return;
        setOptions((o) => {
            const ratio = o.ratio === lock25.ratio ? o.ratio : lock25.ratio;
            const duration = lock25.duration === null || o.duration === lock25.duration ? o.duration : lock25.duration;
            return ratio === o.ratio && duration === o.duration ? o : { ...o, ratio, duration };
        });
    }, [lock25]);

    // Quality upgrades already parked with the admin for THIS project — the
    // locked tier shows "requested" instead of re-offering the modal's ask.
    const pendingTiers = useMemo(() => {
        const m = {};
        for (const r of accessRequests) {
            if (r.project_id !== projectId) continue;
            if (r.status === 'approved' && r.pending_max_resolution) m[r.model_id] = r.pending_max_resolution;
        }
        return m;
    }, [accessRequests, projectId]);

    // A cap (or model switch) can strand a persisted resolution above the
    // granted tier — clamp both media types to the highest tier still offered.
    useEffect(() => {
        setOptions((o) => {
            const next = { ...o };
            const vm = MODELS.find((x) => x.id === o.model);
            if (vm) {
                const ok = (r) => (r !== '1080p' || vm.supports1080p) && (r !== '4k' || vm.supports4k)
                    && resolutionWithinTier(r, tierCaps[vm.id] ?? null, RESOLUTIONS);
                if (!ok(next.resolution)) next.resolution = [...RESOLUTIONS].reverse().find(ok) || '720p';
            }
            const im = IMAGE_MODELS.find((x) => x.id === o.model);
            if (im?.resolutions) {
                // Must be a tier the model still OFFERS and within the grant cap —
                // a persisted 4K selection can't linger on a model that dropped it.
                const okI = (r) => im.resolutions.some((t) => t.toLowerCase() === String(r).toLowerCase())
                    && resolutionWithinTier(r, tierCaps[im.id] ?? null, im.resolutions);
                if (!okI(next.imageResolution)) next.imageResolution = [...im.resolutions].reverse().find(okI) || im.resolutions[0];
            }
            return next.resolution === o.resolution && next.imageResolution === o.imageResolution ? o : next;
        });
    }, [tierCaps, options.model]); // eslint-disable-line react-hooks/exhaustive-deps

    const setOpt = (k, v) => setOptions((o) => {
        const next = { ...o, [k]: v };
        // A model switch can strand a resolution the new model doesn't offer
        // (e.g. 4k on Seedance 2.0 → Mini/Fast); clamp to their 720p ceiling.
        if (k === 'model') {
            const m = MODELS.find((x) => x.id === v);
            if ((next.resolution === '4k' && !m?.supports4k)
                || (next.resolution === '1080p' && !m?.supports1080p)) next.resolution = '720p';
        }
        return next;
    });

    // The image picker offers three choices: Nano Banana Pro, Nano Banana 2 and
    // Cinematic Studio. Studio isn't a model — it runs on Nano Banana Pro with the
    // Cinematic Cameras panel always engaged, so it selects Pro and turns a camera
    // setup on; the two plain models turn the camera styling off.
    const onChangeImageModel = (value) => {
        if (value === IMAGE_STUDIO_ID) {
            setOptions((o) => ({ ...o, model: IMAGE_STUDIO_MODEL_ID, imageStudio: true }));
            setCinematic((c) => c || DEFAULT_SETUP);
        } else {
            setOptions((o) => ({ ...o, model: value, imageStudio: false }));
            setCinematic(null);
        }
        setError(null);
        setNotice(null);
    };

    // Persist every jobs change; functional setter keeps concurrent pollers safe.
    const updateJobs = (fn) => setJobs((prev) => { const next = fn(prev); saveJobs(next); return next; });
    const patchJob = (id, patch) => updateJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));

    // Expired-link recovery: stored videoUrls outlive their signatures
    // (ModelArk ~24h, TOS presigns ≤7d). One refresh per job per session via
    // the archived→live fallback; `fromError` means the <video> actually
    // failed, so a refresh that finds nothing — or a failure after the shot
    // is spent — marks the job `expired` instead of looping on a dead link.
    // While a refresh is in flight extra callers (stage + rail can both ask
    // for the same job) are ignored: the resolution decides, not the race.
    const refreshedRef = useRef(new Map()); // job id → 'pending' | 'done'
    const refreshVideoUrl = (job, { fromError = false } = {}) => {
        if (!job || job.status !== 'done' || job.expired) return;
        // No taskId means nothing to refresh with — treat the shot as spent.
        const state = job.taskId ? refreshedRef.current.get(job.id) : 'done';
        if (state === 'pending') return;
        if (state === 'done') {
            if (fromError) patchJob(job.id, { videoUrl: null, expired: true });
            return;
        }
        refreshedRef.current.set(job.id, 'pending');
        if (fromError) patchJob(job.id, { videoUrl: null }); // dead link → show the loading treatment meanwhile
        resolveFreshVideoUrl(job.taskId).then((url) => {
            refreshedRef.current.set(job.id, 'done');
            if (url) patchJob(job.id, { videoUrl: url, urlRefreshedAt: Date.now() });
            else if (fromError) patchJob(job.id, { expired: true });
        });
    };

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

    // Assets registered for a submit are intentionally NOT deleted when the
    // batch finishes: asset writes share a 120 QPM zero-burst account quota
    // (QuotaWriteQPMExceeded), so resolveMediaRefs reuses them across submits —
    // iterating on the same refs costs zero creates. The 1h age sweep
    // (cleanupOldAssets above) is the single cleanup path.

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
            .finally(() => {
                delete controllersRef.current[jobId];
                // Best-effort cost finalization on either terminal outcome — the
                // server re-fetches the task to decide succeeded vs failed.
                fetch('/api/usage/complete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ taskId }),
                }).catch(() => {});
            });
    };

    // On reload, restore history into the side rail and resume polling for
    // in-flight renders. The big stage auto-loads only an in-process render
    // (else the hero) — finished history plays big only when clicked in the rail.
    // History is SERVER-BACKED: recent tasks are fetched from ModelArk itself
    // and merged in, so the rail survives cleared localStorage / other browsers.
    useEffect(() => {
        // "Reuse" handoff from the Community Gallery: apply the saved setup
        // (prompt + refs + settings + mode) once, then clear it.
        let reused = false;
        try {
            const raw = localStorage.getItem('seedance:reuse');
            if (raw) {
                localStorage.removeItem('seedance:reuse');
                const r = JSON.parse(raw);
                onReuseRefs(
                    { mediaType: r.mediaType, modeId: r.modeId, style: r.style, userPrompt: r.userPrompt, prompt: r.prompt, options: r.options },
                    Array.isArray(r.refs) ? r.refs : [],
                );
                setNotice('Loaded from the gallery — tweak anything and hit Generate.');
                reused = true;
            }
        } catch { /* corrupt handoff — open the studio blank */ }

        // Otherwise bring back the settings this browser last used, so a reload
        // — the reflex after an interrupted generation — comes back to the same
        // mode/model/ratio/resolution/duration/seed instead of the defaults. A
        // gallery "Reuse" is the user explicitly choosing a different setup, so
        // it wins. Either way the bar is now authoritative and safe to save.
        if (!reused) restoreSettings();
        setSettingsReady(true);

        const restored = loadJobs().map((raw) => {
            // Expired marks are session-local — re-probe next visit (the
            // archive may exist by now, or the failure was transient).
            const j = raw.expired ? { ...raw, expired: false } : raw;
            // A job is only truly interrupted if it never got a provider handle
            // (video taskId or image genId) before the page closed.
            return ACTIVE_STATUSES.includes(j.status) && !j.taskId && !j.genId
                ? { ...j, status: 'error', error: 'Interrupted before the task was created.' }
                : j;
        });
        setJobs(restored);
        saveJobs(restored);
        const inFlight = restored.filter((j) => ACTIVE_STATUSES.includes(j.status) && j.taskId);
        for (const j of inFlight) watchJob(j.id, j.taskId);
        // Resume polling image (Nano Banana) batches that were still rendering.
        const inFlightImages = restored.filter((j) => j.mediaType === 'image' && ACTIVE_STATUSES.includes(j.status) && j.genId);
        for (const j of inFlightImages) pollImageJob(j.id, j.genId);
        // Landing stays on the Hero — the user opens a preview by clicking a
        // history item. In-flight jobs still get watched and show in the rail.
        hydratePrompts(restored.filter((j) => !j.userPrompt).map((j) => j.taskId));

        // (Stale-asset cleanup runs per project in its own effect above.)

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
        // Every server-restored card that wasn't created on this device is
        // re-validated for ownership: the prompts API only returns records for
        // the caller's own tasks, so any srv-* card that isn't confirmed owned
        // is a teammate's generation a past session merged in — purge it.
        const suspects = restored.filter(
            (j) => String(j.id).startsWith('srv-') && j.taskId && !prompts[j.taskId],
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

        // The user's COMPLETE own history from the DB (usage_events ⋈ prompts),
        // independent of ModelArk's recent-30 window — so older own generations,
        // and ones made on another device, still appear in the rail.
        fetch('/api/gallery?mine=1')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                const items = Array.isArray(d?.items) ? d.items : [];
                if (!items.length) return;
                const toStatus = (s) => (s === 'succeeded' ? 'done' : ['queued', 'running'].includes(s) ? s : 'error');
                updateJobs((prev) => {
                    const known = new Set(prev.map((j) => j.taskId).filter(Boolean));
                    // Image jobs have no provider task id: the server keys them
                    // 'job:<genId>'. Skip any we already track locally by genId,
                    // else the same image shows twice (local card + server merge).
                    const knownGen = new Set(prev.map((j) => (j.genId != null ? String(j.genId) : null)).filter(Boolean));
                    const isDupImage = (it) => it.mediaType === 'image'
                        && typeof it.taskId === 'string' && it.taskId.startsWith('job:')
                        && knownGen.has(it.taskId.slice(4));
                    const added = items
                        .filter((it) => it.taskId && !known.has(it.taskId) && !isDupImage(it))
                        .map((it) => {
                            const isImage = it.mediaType === 'image';
                            return {
                                id: `srv-${it.taskId}`,
                                taskId: it.taskId,
                                mediaType: it.mediaType || 'video',
                                projectId: it.projectId ?? null,
                                prompt: it.prompt || '',
                                userPrompt: it.userPrompt || null,
                                style: it.style || null,
                                modeId: isImage ? 'image' : null,
                                refs: it.refs || null,
                                options: { model: it.modelId, resolution: it.resolution, duration: it.duration, ratio: it.ratio },
                                model: it.modelId,
                                status: toStatus(it.status),
                                genId: null,
                                videoUrl: isImage ? null : (it.archiveUrl || null),
                                archiveKey: isImage ? null : (it.taskId ? archiveKeyForTask(it.taskId) : null),
                                imageUrl: isImage ? (it.imageUrl || null) : null,
                                error: null,
                                liked: !!it.liked,
                                deleted: false,
                                deletedAt: null,
                                createdAt: it.createdAt ? new Date(it.createdAt).getTime() : Date.now(),
                            };
                        });
                    return added.length ? [...prev, ...added].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) : prev;
                });
            })
            .catch(() => { /* DB history unavailable: ModelArk merge + local still work */ });

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
    const registerInto = async (slot, { name, initialStatus, resolveUrl, metadata = {} }) => {
        setError(null);
        const key = `pending-${pendingRef.current++}`;
        const placeholder = { kind: slot.kind, role: slot.role, url: '', name, isImage: slot.kind === 'image', pending: true, status: initialStatus, pendingKey: key };
        setMediaByRole((prev) => ({ ...prev, [slot.role]: [...(prev[slot.role] || []), placeholder].slice(0, slot.max) }));

        const patch = (fn) => setMediaByRole((prev) => ({ ...prev, [slot.role]: (prev[slot.role] || []).map((m) => (m.pendingKey === key ? fn(m) : m)) }));
        const drop = () => setMediaByRole((prev) => ({ ...prev, [slot.role]: (prev[slot.role] || []).filter((m) => m.pendingKey !== key) }));

        try {
            const up = await resolveUrl();
            patch(() => mediaItemFromUpload(slot, name, up, metadata));
        } catch (e) {
            drop();
            setError(e.message);
        }
    };

    // Pick a local file → upload to TOS, then register that URL.
    const onUploadFile = (slot, file, metadata) =>
        registerInto(slot, { name: file.name, initialStatus: 'Uploading', resolveUrl: () => uploadToCdn(file), metadata });

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
            // Oversized images are auto-downscaled to fit the Seedance limits
            // (longest side ≤ 6000px, ≤ 30MB) instead of being rejected. Aspect /
            // min-dimension problems downscaling can't fix still error below.
            const f = kind === 'image' ? await fitImageToLimits(file) : file;
            const { error: invalid, meta } = await validateMediaFile(kind, f);
            if (invalid) { setError(invalid); continue; }
            // A clip an editing prompt would reject (2.5 edits need 4–30s) is
            // still a valid reference — attach it, but say so up front instead
            // of letting the task fail asynchronously after it's been priced.
            if (kind === 'video') {
                const warn = editClipWarning(selectedModel?.kind, meta?.durationSec, f.name);
                if (warn) setNotice(warn);
            }
            used[slot.role] += 1;
            onUploadFile(slot, f, meta);
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
    // Neon prompt-pair store, powering the enhancer/user comparison tabs.
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
            projectId, // scope this generation to the active project
        });
        updateJobs((prev) => [job, ...prev]);
        setSelectedId(job.id); // a fresh generation takes the big stage
        const MAX_ATTEMPTS = 6;
        const RETRY_DELAY_MS = 15000;
        // Real-person media no longer needs a reactive re-reference here: every
        // http image/video is verified as a library asset in the submit
        // pre-flight (resolveMediaRefs), so nothing raw reaches ModelArk's scan.
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                const taskId = await createTask(payload, creation.modeId ?? modeId, projectId);
                savePrompt(taskId, promptText); // survives any history wipe
                savePromptRecord({
                    taskId,
                    userPrompt: promptMeta?.userPrompt ?? promptText,
                    generatedPrompt: promptMeta ? promptText : null,
                    style: promptMeta?.style ?? null,
                    refs: creation.refs ?? null,
                    projectId,
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

    // Flip Image ↔ Video, keeping options.model valid for the active type.
    // Image-mode reference images: downscaled to ~1024px JPEG, kept as base64
    // so they can go inline as {inlineData} parts. NOT persisted to the job /
    // localStorage (base64 would blow the quota) — send-time only.
    const onUploadImageRefs = async (files) => {
        const cap = imageRefMax(options.model); // Nano Banana Pro takes 14, Flash 3
        const picked = Array.from(files || []).filter((f) => f.type?.startsWith('image/'));
        for (const file of picked) {
            if (imageRefs.length >= cap) break;
            try {
                const ref = await downscaleForInline(file);
                setImageRefs((prev) => (prev.length >= cap ? prev : [...prev, { name: file.name, ...ref }]));
            } catch { /* unreadable image — skip */ }
        }
    };
    const removeImageRef = (i) => setImageRefs((prev) => prev.filter((_, idx) => idx !== i));
    const reorderImageRefs = (from, to) => setImageRefs((prev) => moveItem(prev, from, to));

    const changeMediaType = (t) => {
        setMediaType(t);
        setError(null);
        setNotice(null);
        setImageRefs([]);
        if (t === 'image') {
            // Studio always runs on Nano Banana Pro; otherwise keep a valid image
            // model (falling back to the default when arriving from video).
            if (options.imageStudio) setOpt('model', IMAGE_STUDIO_MODEL_ID);
            else if (!IMAGE_MODELS.some((m) => m.id === options.model)) setOpt('model', IMAGE_DEFAULT_MODEL_ID);
        } else if (!MODELS.some((m) => m.id === options.model)) {
            setOpt('model', DEFAULT_OPTIONS.model);
        }
    };

    // Image mode (Nano Banana) runs through the gateway's async batch queue, not
    // the ModelArk video proxy: submit → poll the generation until the Gemini
    // batch settles → resolve the stored image to a URL. Each poll of the job
    // also drives the server-side sweep, so polling itself advances the batch.
    const resolveImageUrl = async (img) => {
        if (!img) return null;
        if (img.b64) return `data:${img.mimeType || 'image/png'};base64,${img.b64}`;
        if (img.url) return img.url;
        if (img.key) {
            try {
                const res = await fetch(`/api/byteplus/archive?key=${encodeURIComponent(img.key)}`);
                const d = res.ok ? await res.json() : null;
                return d?.url || null;
            } catch { return null; }
        }
        return null;
    };

    const pollImageJob = async (localId, genId) => {
        patchJob(localId, { genId, status: 'queued' });
        const MAX_ATTEMPTS = 225; // ~15 min at 4s — Gemini batch is async
        for (let i = 0; i < MAX_ATTEMPTS; i++) {
            await new Promise((r) => setTimeout(r, 4000));
            let d = null;
            try {
                const res = await fetch(`/api/generations/${genId}`);
                d = res.ok ? await res.json() : null;
            } catch { continue; }
            if (!d) continue;
            if (d.status === 'succeeded') {
                const url = await resolveImageUrl(d.result?.images?.[0]);
                patchJob(localId, url
                    ? { status: 'done', imageUrl: url }
                    : { status: 'error', error: 'The image finished but could not be loaded.' });
                return;
            }
            if (d.status === 'failed' || d.status === 'cancelled' || d.status === 'timed_out') {
                patchJob(localId, { status: 'error', error: d.error?.message || 'Image generation failed.' });
                return;
            }
            patchJob(localId, { status: 'running' }); // still queued/running
        }
        patchJob(localId, { status: 'error', error: 'Timed out waiting for the image.' });
    };

    const launchImageJob = async (promptText, refs = [], meta = null) => {
        const base = newJob({ prompt: promptText, model: options.model, modeId: 'image', options: { ...options }, projectId, mediaType: 'image' });
        // Cinematic: keep the raw prompt + camera setup on the job so history
        // shows a raw-vs-structured compare and can label the look.
        const job = meta ? { ...base, userPrompt: meta.userPrompt || null, cinematic: meta.cinematic || null } : base;
        updateJobs((prev) => [job, ...prev]);
        setSelectedId(job.id);
        patchJob(job.id, { status: 'running' });
        // Reference images ride along as inline {inlineData} parts — Gemini
        // edits/combines them with the prompt. Prompt-only jobs send just text.
        const request = refs.length
            ? { prompt: promptText, parts: [{ text: promptText }, ...refs.map((r) => ({ inlineData: { mimeType: r.mimeType, data: r.b64 } }))] }
            : { prompt: promptText };
        // Gemini imageConfig: aspect ratio + resolution (imageSize) go on every
        // image model. Pro honours 2K/4K fully; Banana 2 accepts the field but
        // Google may cap it near 1K — still sent so the choice is respected where
        // supported. `resolutions` gates it defensively for any future fixed model.
        const imgModelDef = IMAGE_MODELS.find((m) => m.id === options.model);
        try {
            const res = await fetch('/api/generations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectId, modelId: options.model, request,
                    options: {
                        imageCount: 1,
                        aspectRatio: options.imageRatio || null,
                        imageSize: imgModelDef?.resolutions ? (options.imageResolution || null) : null,
                    },
                }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.generationId) {
                patchJob(job.id, { status: 'error', error: data?.error?.message || data?.message || 'Image generation could not start.' });
                return;
            }
            pollImageJob(job.id, data.generationId);
        } catch (e) {
            patchJob(job.id, { status: 'error', error: e.message });
        }
    };

    const onGenerate = async () => {
        if (enhancing) return;
        setError(null);
        setNotice(null);
        // Don't fire before the project resolves — a generation with no project
        // header silently bills to Default, diverging from the shown project.
        if (projects.length && !projectId) { setError('Still loading your project — try again in a moment.'); return; }

        // Image mode: straight to the gateway batch queue. When a Cinematic
        // Cameras setup is active, the enhancer restructures the prompt around the
        // camera settings first (one enhance for the whole batch).
        if (mediaType === 'image') {
            const raw = prompt.trim();
            if (!raw) { setError('Describe the image you want to create.'); return; }
            let structured = raw;
            let meta = null;
            if (cinematic) {
                setEnhancing(true);
                try {
                    const result = await enhancePrompt({ style: 'cinematic_camera', prompt: raw, camera: cinematicToPayload(cinematic) });
                    if (result.refused) {
                        setNotice(result.reason || 'Prompt restructuring was declined — generating from your prompt as-is.');
                    } else {
                        structured = result.prompt;
                        meta = { userPrompt: raw, cinematic };
                    }
                } catch (e) {
                    setError(e.message);
                    setEnhancing(false);
                    return;
                }
                setEnhancing(false);
            }
            for (let i = 0; i < batch; i++) launchImageJob(structured, imageRefs, meta);
            return;
        }
        // Belt to the picker's suspenders: never submit a reference-based mode
        // on a model that can't run r2v — the provider rejects it after the fact.
        if (!modeAllowedForModel(mode, selectedModel)) {
            setError(`${selectedModel?.name || 'This model'} doesn't support ${mode.name} — switch the model to Seedance 2.0, or the mode to Text/Image → Video.`);
            return;
        }
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

        // Styled modes (Motion Capture / Green Screen): the enhancer restructures the
        // raw prompt into the full production brief before Seedance sees it. If
        // the enhancer REFUSES the content, fall back to the user's own prompt and
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

        // A reused ref may point at an asset:// that per-batch cleanup already
        // deleted; re-source it from its TOS key first so the verification below
        // registers a live asset instead of shipping a dead id to ModelArk.
        let resolvedItems = await rehydrateStaleAssetRefs(mediaItems);

        // Source media (images AND videos) must go through the Asset Library:
        // ModelArk's input scan rejects real-person footage/portraits referenced
        // by raw URL, but the same file passes as a verified asset:// ref
        // (~10–30s verification each). Audio and asset:// refs pass through.
        if (resolvedItems.some((m) => (m.kind === 'image' || m.kind === 'video') && /^https?:/i.test(String(m.url)))) {
            setEnhancing(true);
            setNotice('Verifying reference media (takes ~30s)…');
            try {
                resolvedItems = await resolveMediaRefs(resolvedItems, (a) => registerAssetFromUrl({ ...a, project: activeProject }));
            } catch (e) {
                setError(`Reference verification failed — ${e.message}`);
                return;
            } finally {
                setEnhancing(false);
                setNotice(null);
            }
        }

        let payload;
        try {
            payload = buildPayload({ options, prompt: apiPrompt, mediaItems: resolvedItems });
        } catch (e) {
            setError(e.message);
            return;
        }

        // Snapshot the attached reference assets (asset:// links live in the
        // BytePlus library, so they stay reusable from history; data: URLs
        // would bloat storage and are skipped). Powers the panel + Reuse.
        const refs = resolvedItems
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

        // Fire `batch` parallel generations (seed -1 → each gets its own random
        // seed). Registered assets are shared by the batch AND later submits
        // (resolveMediaRefs cache) — the 1h age sweep cleans them up.
        for (let i = 0; i < batch; i++) launchJob(payload, apiPrompt, promptMeta, creation);
    };

    /* ── settings memory (survives a reload) ────────────────────────────── */

    // Everything unpackSettings needs to validate a stored entry against the
    // LIVE catalog — it can't import the constants itself and stay testable.
    const settingsCatalog = () => ({
        defaults: DEFAULT_OPTIONS,
        modeIds: MODES.map((m) => m.id),
        modelIds: MODELS.map((m) => m.id),
        ratios: RATIOS,
        resolutions: RESOLUTIONS,
        modelSupports1080p: (id) => !!MODELS.find((m) => m.id === id)?.supports1080p,
        modelSupports4k: (id) => !!MODELS.find((m) => m.id === id)?.supports4k,
        imageModelIds: IMAGE_MODELS.map((m) => m.id),
        imageRatios: IMAGE_RATIOS,
        imageResolutions: IMAGE_RESOLUTIONS,
        imageDefaultModelId: IMAGE_DEFAULT_MODEL_ID,
        imageStudioModelId: IMAGE_STUDIO_MODEL_ID,
    });

    // Put the remembered settings back in the bar. Only the pills are touched:
    // prompt and references are never stored, so a reload never re-attaches a
    // file or refills a prompt. The access guards that run after this still get
    // the last word — a model revoked while the tab was closed, or a tier now
    // above the granted cap, falls back exactly as it does for any selection.
    const restoreSettings = () => {
        const s = unpackSettings(loadSettings(), settingsCatalog());
        if (!s) return;
        if (s.modeId) setModeId(s.modeId);
        setMediaType(s.mediaType);
        // Merged over the live defaults, not swapped in: a setting added to
        // DEFAULT_OPTIONS after this entry was written keeps its default rather
        // than coming back undefined.
        setOptions((cur) => ({ ...cur, ...s.options }));
        // Cinematic Studio without a camera rig would be a dead toggle — the
        // model picker sets one when you choose Studio, so match that here.
        if (s.options.imageStudio) setCinematic((c) => c || DEFAULT_SETUP);
    };

    // Save on every settings change. These are pill clicks, not keystrokes, so
    // a direct write is cheap and nothing needs debouncing.
    useEffect(() => {
        if (!settingsReady) return;
        saveSettings(packSettings({ modeId, mediaType, options }));
    }, [settingsReady, modeId, mediaType, options]);

    // "Reuse" on a history card: load that generation's reference assets AND
    // its prompt back into the prompt bar — restoring the mode it was made in,
    // so every ref lands in its original slot (clamped to the mode's per-slot
    // max). The raw user prompt wins over the enhancer brief: in styled modes the
    // brief is regenerated on the next Generate anyway.
    const onReuseRefs = (job, refs) => {
        // Reusing an image (Nano Banana) job: flip the toggle to Image mode and
        // restore its model + prompt. The video mode/refs/options restore below
        // doesn't apply to images and would strand the prompt in Video mode.
        if (job.mediaType === 'image') {
            setMediaType('image');
            setImageRefs([]); // inline refs weren't persisted; user re-adds if needed
            // Cinematic Studio if it carried a camera setup. It's its own model
            // now, so a Studio reuse resolves to IMAGE_STUDIO_MODEL_ID even for
            // pre-change jobs that were saved under 'nano-banana-pro'.
            const studio = job.options?.imageStudio ?? !!job.cinematic;
            const imgModel = studio ? IMAGE_STUDIO_MODEL_ID
                : IMAGE_MODELS.some((m) => m.id === job.model) ? job.model
                    : IMAGE_MODELS.some((m) => m.id === job.options?.model) ? job.options.model
                        : IMAGE_DEFAULT_MODEL_ID;
            setOptions((cur) => ({
                ...cur,
                model: imgModel,
                imageRatio: IMAGE_RATIOS.includes(job.options?.imageRatio) ? job.options.imageRatio : cur.imageRatio,
                imageResolution: IMAGE_RESOLUTIONS.includes(job.options?.imageResolution) ? job.options.imageResolution : cur.imageResolution,
                imageStudio: studio,
            }));
            setPrompt(job.userPrompt || job.prompt || '');
            setCinematic(job.cinematic ? sanitizeSetup(job.cinematic) : null); // restore the camera setup so "Reuse this setup" re-enhances the same way
            setError(null);
            setNotice(null);
            return;
        }
        // Reusing a video job while in Image mode: flip back to Video first.
        if (mediaType === 'image') setMediaType('video');
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
                tosKey: r.tosKey || null, // lets a stale asset:// be re-sourced at submit
                fromLibrary: true,
            });
        }
        setModeId(target.id);
        setMediaByRole(byRole);
        // Restore the generation settings (duration, aspect ratio, resolution,
        // audio, watermark, seed, model) this job was made with — sanitized
        // against the current catalog. Older jobs without a snapshot keep the
        // current settings (sanitizeOptions falls back to the live values).
        setOptions((cur) => ({
            // sanitizeOptions returns only the video fields — carry the image
            // (Gemini) settings through untouched so a video reuse never wipes them.
            imageRatio: cur.imageRatio,
            imageResolution: cur.imageResolution,
            imageStudio: cur.imageStudio,
            ...sanitizeOptions(job.options, {
                defaults: cur,
                modelIds: MODELS.map((m) => m.id),
                ratios: RATIOS,
                resolutions: RESOLUTIONS,
                modelDurationMax: (id) => durationMaxFor(id),
                modelSupports1080p: (id) => !!MODELS.find((m) => m.id === id)?.supports1080p,
                modelSupports4k: (id) => !!MODELS.find((m) => m.id === id)?.supports4k,
            }),
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
        // On rejection (e.g. another creator's generation — everyone can view
        // and reuse, only the owner can bin) revert the optimistic flag.
        if (job?.taskId) {
            const res = await setBinRecord({ taskId: job.taskId, deleted: true });
            if (!res.ok) {
                patchJob(id, { deleted: false, deletedAt: null });
                setError(res.error || 'Could not move it to the bin — it may still appear in other browsers.');
            }
        }
    };

    // Restore a binned generation back into history (locally + on the server).
    const onRestoreJob = async (id) => {
        const job = jobs.find((j) => j.id === id);
        patchJob(id, { deleted: false, deletedAt: null });
        if (job?.taskId) {
            const res = await setBinRecord({ taskId: job.taskId, deleted: false });
            if (!res.ok) setError(res.error || 'Restored here, but the server update failed — it may still be binned in other browsers.');
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
            const res = await deletePromptRecord({ taskId: job.taskId });
            if (!res.ok) setError(res.error || 'Removed here, but the server delete failed — it may reappear on reload.');
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
    // History is scoped strictly to the active project so nothing flashes in
    // and gets culled. Until the projects fetch resolves we render no jobs at
    // all (projectsLoaded gate); legacy untagged jobs are backfilled to the
    // home project (effect above), so by first paint every job has a project.
    // projectId == null only when there's no gateway/project at all → show all.
    const belongsToProject = (j) => projectId == null || j.projectId === projectId;
    const scopedJobs = projectsLoaded ? jobs.filter(belongsToProject) : [];
    const visibleJobs = scopedJobs.filter((j) => !j.deleted);

    // Landing opens on the Hero, never a preview. The big stage appears only
    // when the user clicks a history item (or starts a fresh generation).
    // autoSelectedRef is still reset on project switch (see selectProject).
    const binnedJobs = scopedJobs.filter((j) => j.deleted);
    const activeCount = visibleJobs.filter((j) => ACTIVE_STATUSES.includes(j.status)).length;
    const doneCount = visibleJobs.filter((j) => j.status === 'done' && j.videoUrl).length;
    // What plays big in the center: only an explicitly selected job (set by a
    // rail click, a fresh Generate, or an in-flight resume) — never auto-play
    // old history after a reload. A binned job never plays on the stage.
    const selectedJob = jobs.find((j) => j.id === selectedId && !j.deleted && belongsToProject(j)) || null;
    // A finished video/image opens in the full-screen AssetViewer (the big
    // preview); other states (rendering, expired, error) stay in the center stage.
    const viewerJob = selectedJob && selectedJob.status === 'done' && (selectedJob.videoUrl || selectedJob.imageUrl) && !selectedJob.expired ? selectedJob : null;

    // A selected card can carry a link that's already gone (restored from
    // localStorage) or ~20h+ old and about to 403: refresh it up front —
    // clearing the stale URL so the player never wastes a network failure on
    // it — instead of letting the big stage spin forever at 0:00.
    useEffect(() => {
        // Image results carry a 7-day presigned URL — nothing to refresh.
        if (!selectedJob || selectedJob.mediaType === 'image' || selectedJob.status !== 'done' || selectedJob.expired) return;
        if (!selectedJob.videoUrl || isStaleUrl(selectedJob)) refreshVideoUrl(selectedJob, { fromError: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedId]);

    // No memberships → nothing to scope generations to. Signups are NOT
    // auto-enrolled in any project (no silent Default fallback), so a plain
    // member waits for an admin to add them. Admins/managers see every
    // project, so for them this only appears on a fresh install.
    if (projectsLoaded && projects.length === 0) {
        return (
            <div className="flex min-h-screen w-full flex-col items-center justify-center gap-4 bg-app-bg px-6 text-center text-white">
                <h1 className="text-xl font-semibold">You’re not in a project yet</h1>
                <p className="max-w-md text-sm leading-relaxed text-white/50">
                    {canManageProjects
                        ? 'Everything in the studio — generations, references, budgets — is scoped to a project. Create one to get started.'
                        : 'Everything in the studio is scoped to a project. Ask your workspace admin to add you to one, then reload this page.'}
                </p>
                {canManageProjects && (
                    <a href="/projects" className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-black hover:opacity-90">
                        Create a project
                    </a>
                )}
            </div>
        );
    }

    return (
        <div className="relative min-h-screen w-full bg-app-bg text-white">
            {/* Slim top bar (all sizes) — the nav rail lives on /projects now;
                the studio keeps just the project scope + essentials. */}
            <div className="fixed inset-x-3 top-3 z-40 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setSelectedId(null)} title="Home" className="flex items-center gap-1.5 rounded-md border border-line bg-paper-2 px-2.5 py-1.5 text-xs font-semibold text-ink-2">
                        <span className="grid h-4 w-4 place-items-center rounded bg-accent font-display text-[10px] font-bold text-accent-ink">L</span>
                        LoglineAI{activeCount > 0 && <span className="ml-0.5 text-accent-hi">· {activeCount}</span>}
                    </button>
                    <Link href="/projects" title="Back to projects" className="grid h-7 w-7 place-items-center rounded-md border border-line bg-paper-2 text-ink-3 transition-colors hover:text-ink">
                        <ArrowLeft size={14} />
                    </Link>
                    {projects.length > 0 && <ProjectSelect projects={projects} value={projectId} onChange={selectProject} />}
                    <BudgetRemaining projectId={projectId} modelId={options.model} refreshKey={budgetVersion} />
                    {!isAdmin && projectId && (
                        <button type="button" onClick={() => setBudgetRequestOpen(true)} title="Request more budget"
                            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-paper-2 px-2.5 text-[11px] font-semibold text-ink-2 transition-colors hover:border-accent/40 hover:text-accent-hi">
                            <WalletCards size={13} /> <span className="hidden sm:inline">Request budget</span>
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <MySpend project={projects.find((p) => p.id === projectId) ?? null} />
                    {isAdmin && (
                        <Link href="/console" title="Console" className="grid h-7 w-7 place-items-center rounded-md border border-line bg-paper-2 text-warn/80 transition-colors hover:text-warn">
                            <ShieldCheck size={14} />
                        </Link>
                    )}
                    <button type="button" onClick={() => setShowAssets(true)} title="Assets" className="rounded-md border border-line bg-paper-2 p-1.5 text-ink-2">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
                    </button>
                    <UserButton />
                </div>
            </div>

            {budgetRequestOpen && projectId ? (
                <BudgetRequestModal
                    projectId={projectId}
                    onClose={() => setBudgetRequestOpen(false)}
                    onSent={(request) => {
                        setBudgetRequestOpen(false);
                        setNotice(`Budget request sent — an admin will review the $${Number(request?.increaseAmount || 0).toFixed(2)} increase for ${request?.modelName || 'your models'}.`);
                    }}
                />
            ) : null}


            {/* Center stage: hero when empty, else the selected job plays big.
                Finished generations live in the right-side history rail. */}
            <div className={`relative z-10 flex min-h-screen flex-col items-center justify-center px-4 pt-16 pb-[24rem] ${selectedJob ? 'sm:pb-24' : 'sm:pb-56'} ${visibleJobs.length > 0 ? 'sm:pr-52' : ''}`}>
                {selectedJob && !viewerJob ? (
                    <BigStage
                        key={selectedJob.id} /* remount on job switch → PromptTabs resets to the default tab */
                        job={selectedJob}
                        onCancel={() => onCancelJob(selectedJob.id)}
                        onFullscreen={() => selectedJob.videoUrl && setFullscreen(selectedJob.videoUrl)}
                        onReuse={onReuseRefs}
                        onRefresh={() => refreshVideoUrl(selectedJob, { fromError: true })}
                    />
                ) : (
                    <Hero />
                )}
            </div>

            {visibleJobs.length > 0 && (
                <HistoryRail
                    jobs={visibleJobs}
                    selectedId={selectedJob?.id}
                    onSelect={setSelectedId}
                    onRemove={onBinJob}
                    onToggleLike={onToggleLike}
                    onRefresh={refreshVideoUrl}
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
                models={visibleVideoModels}
                allowedModelIds={allowedModelIds}
                projectId={projectId}
                resolutions={resolutions}
                tierCaps={tierCaps}
                pendingTiers={pendingTiers}
                selectedModel={selectedModel}
                lock25={lock25}
                error={error}
                notice={notice}
                setNotice={setNotice}
                onGenerate={onGenerate}
                enhancing={enhancing}
                batch={batch}
                setBatch={setBatch}
                onMediaError={setError}
                onUploadFiles={onUploadFiles}
                tags={tags}
                mediaType={mediaType}
                onChangeMediaType={changeMediaType}
                imageModels={IMAGE_MODELS}
                imageStudio={options.imageStudio}
                onChangeImageModel={onChangeImageModel}
                imageRefs={imageRefs}
                onUploadImageRefs={onUploadImageRefs}
                removeImageRef={removeImageRef}
                reorderImageRefs={reorderImageRefs}
                cinematic={cinematic}
                onOpenCinematic={() => setShowCinematic(true)}
            />

            <CinematicPanel
                open={showCinematic}
                setup={cinematic}
                onApply={setCinematic}
                onClose={() => setShowCinematic(false)}
            />

            {fullscreen && <Fullscreen url={fullscreen} onClose={() => setFullscreen(null)} />}

            {viewerJob && (() => {
                // ← / → step through the finished, still-playable generations
                // (the ones that would open here) in rail order.
                const viewable = visibleJobs.filter((j) => j.status === 'done' && (j.videoUrl || j.imageUrl) && !j.expired);
                const i = viewable.findIndex((j) => j.id === viewerJob.id);
                return (
                    <AssetViewer
                        key={viewerJob.id}
                        job={viewerJob}
                        onClose={() => setSelectedId(null)}
                        onReuse={onReuseRefs}
                        onToggleLike={onToggleLike}
                        onRefresh={() => refreshVideoUrl(viewerJob, { fromError: true })}
                        onPrev={i > 0 ? () => setSelectedId(viewable[i - 1].id) : null}
                        onNext={i >= 0 && i < viewable.length - 1 ? () => setSelectedId(viewable[i + 1].id) : null}
                    />
                );
            })()}

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
function BigStage({ job, onCancel, onFullscreen, onReuse, onRefresh }) {
    const active = ACTIVE_STATUSES.includes(job.status);
    // The stored link expired and neither the archived copy nor the live task
    // record could revive it — a clean dead-end card instead of a player
    // spinning forever at 0:00. Reuse still restores the full setup.
    if (job.status === 'done' && job.expired) {
        const hasPrompt = !!(job.prompt || job.userPrompt || job.refs?.length);
        const card = (
            <div className="relative rounded-2xl overflow-hidden border border-white/10 bg-black/40 aspect-video flex flex-col items-center justify-center gap-3 px-8 text-center">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-white/25"><path d="M16 16v1a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h2m5.66 0H14a2 2 0 012 2v3.34l1 1L23 7v10" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
                <p className="text-sm text-white/45 leading-relaxed max-w-sm">This video’s link expired and no archived copy exists — use Reuse to regenerate it.</p>
                <button
                    type="button"
                    onClick={() => onReuse(job, job.refs || [])}
                    title="Load this prompt, references and settings back into the prompt bar"
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary/15 border border-primary/40 text-primary text-xs font-bold hover:bg-primary/25 transition-colors"
                >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 4v6h6M23 20v-6h-6" /><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" /></svg>
                    Reuse
                </button>
            </div>
        );
        if (!hasPrompt) return <div className="w-full max-w-3xl animate-fade-in-up">{card}</div>;
        return (
            <div className="w-full max-w-6xl animate-fade-in-up">
                <div className="flex flex-col lg:flex-row gap-4 justify-center lg:items-start">
                    <div className="flex-1 min-w-0 max-w-5xl mx-auto lg:mx-0">{card}</div>
                    <PromptTabs job={job} onReuse={onReuse} />
                </div>
            </div>
        );
    }
    if (job.status === 'done' && job.videoUrl) {
        const hasPrompt = !!(job.prompt || job.userPrompt || job.refs?.length);
        return (
            <div className={`w-full animate-fade-in-up ${hasPrompt ? 'max-w-7xl' : 'max-w-5xl'}`}>
                {/* Video left, prompt panel on the RIGHT (stacks below on small screens). */}
                <div className="flex flex-col lg:flex-row gap-4 justify-center lg:items-start">
                    <div className="flex-1 min-w-0 max-w-5xl mx-auto lg:mx-0">
                        <div className="relative rounded-2xl overflow-hidden border border-white/10 bg-black shadow-2xl">
                            <video
                                key={job.id}
                                src={job.videoUrl}
                                controls
                                autoPlay
                                loop
                                playsInline
                                onError={onRefresh}
                                // Sound on by default; if the browser blocks unmuted
                                // autoplay (fresh page load, no gesture yet), fall back
                                // to muted so the video still starts.
                                ref={(el) => {
                                    if (!el || el.dataset.soundTried) return;
                                    el.dataset.soundTried = '1';
                                    el.muted = false;
                                    el.play?.()?.catch(() => { el.muted = true; el.play().catch(() => {}); });
                                }}
                                className="w-full max-h-[82vh] object-contain bg-black"
                            />
                            <div className="absolute top-3 right-3 flex gap-2">
                                <button type="button" onClick={onFullscreen} title="Fullscreen" className="p-2 rounded-full bg-black/60 border border-white/10 text-white/80 hover:text-white hover:bg-black/80 transition-colors backdrop-blur-sm">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M16 21h3a2 2 0 002-2v-3M8 21H5a2 2 0 01-2-2v-3" /></svg>
                                </button>
                                <button type="button" onClick={() => downloadAsset(job.videoUrl, job.taskId || 'video', job.taskId)} title="Download" aria-label="Download" className="p-2 rounded-full bg-black/60 border border-white/10 text-white/80 hover:text-primary hover:bg-black/80 transition-colors backdrop-blur-sm">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
                                </button>
                            </div>
                        </div>
                        {!hasPrompt && <p className="mt-3 text-center text-xs text-white/35 truncate px-6" title={job.meta}>{job.meta}</p>}
                    </div>
                    {hasPrompt && <PromptTabs job={job} onReuse={onReuse} />}
                </div>
            </div>
        );
    }
    if (job.status === 'done' && !job.videoUrl) {
        // Link refresh in flight (archived→live fallback, sub-second) — a
        // light spinner card, not the full "Rendering…" treatment.
        return (
            <div className="w-full max-w-3xl animate-fade-in-up">
                <div className="relative rounded-2xl overflow-hidden border border-white/10 bg-black/30 aspect-video flex flex-col items-center justify-center gap-2">
                    <span className="animate-spin inline-block text-primary text-xl">◌</span>
                    <span className="text-xs font-semibold text-white/40">Refreshing the video link…</span>
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
                <h2 className="text-2xl md:text-3xl font-extrabold font-display tracking-tight mb-3">{STATUS_TEXT[job.status] || 'Working…'}</h2>
                <p className="text-white/40 text-sm md:text-base max-w-md leading-relaxed">
                    Usually 1–5 minutes. It keeps rendering even if you reload — watch it land in the rail on the right.
                </p>
                {job.taskId && <p className="mt-3 text-[11px] font-mono text-white/20 break-all max-w-md">task {job.taskId}</p>}
                <button type="button" onClick={onCancel} className="mt-5 px-3 py-2 rounded-md text-xs font-semibold text-white/60 hover:text-white border border-white/10 hover:border-white/25 transition-colors">Cancel</button>
            </div>
        );
        if (!hasPrompt) return <div className="animate-fade-in-up">{placeholder}</div>;
        return (
            <div className="w-full max-w-6xl animate-fade-in-up">
                {/* Spinner left, the submitted prompt + reference assets on the
                    RIGHT — same layout the finished video uses. */}
                <div className="flex flex-col lg:flex-row gap-4 justify-center lg:items-start">
                    <div className="flex-1 min-w-0 max-w-5xl mx-auto lg:mx-0">
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
            <p className="px-4 py-3 rounded-xl bg-danger/10 border border-danger/20 text-sm text-danger leading-relaxed">{friendlyError(job.error) || 'Generation failed.'}</p>
            <p className="mt-3 text-xs text-white/30 truncate" title={job.prompt}>{job.prompt}</p>
        </div>
    );
}

// Side panel to the RIGHT of a played video: the prompt actually sent to the
// model. In styled modes (Motion Capture / Green Screen) it's the enhancer brief,
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
            { id: 'generated', label: 'Enhanced prompt', text: generated },
            { id: 'user', label: 'Your prompt', text: userPrompt },
        ]
        : [{ id: 'generated', label: 'Prompt', text: generated || userPrompt }];
    const current = tabs.find((t) => t.id === tab) || tabs[0];
    // Which model produced this video — friendly name when the id is in the
    // catalog, the raw id for rotated/legacy ones, nothing for old jobs that
    // predate the model field.
    const modelName = job.model ? (MODELS.find((m) => m.id === job.model)?.name ?? IMAGE_MODELS.find((m) => m.id === job.model)?.name ?? job.model) : null;
    return (
        <div className="w-full lg:w-80 xl:w-96 shrink-0 flex flex-col max-h-[40vh] lg:max-h-[64vh] rounded-2xl border border-white/10 bg-white/[0.02] backdrop-blur-sm overflow-hidden">
            {(hasText || modelName) && (
                <>
                    <div className="flex items-center gap-1 p-2 border-b border-white/[0.06] shrink-0">
                        {hasText && tabs.map((t) => (
                            <button
                                key={t.id}
                                type="button"
                                onClick={() => setTab(t.id)}
                                className={`px-3 py-1.5 rounded-md text-[11px] font-semibold transition-colors ${t.id === current.id ? 'bg-primary/15 text-primary' : 'text-white/40 hover:text-white hover:bg-white/[0.06]'}`}
                            >{t.label}</button>
                        ))}
                        {modelName && (
                            <span className="ml-auto pr-1 max-w-[45%] truncate text-[9px] uppercase tracking-wider text-white/25" title={`Generated with ${modelName}`}>
                                {hasBoth && current.id === 'generated' ? `sent to ${modelName}` : modelName}
                            </span>
                        )}
                    </div>
                    {hasText && (
                        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 py-3">
                            <p className="text-xs leading-relaxed text-white/60 whitespace-pre-wrap break-words">{current.text}</p>
                        </div>
                    )}
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

// Rail tile stand-in: subtle gradient + film glyph, so a tile never renders
// as an empty black void; `expired` adds the tiny badge for dead links.
function TilePlaceholder({ expired }) {
    return (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-white/[0.07] via-black/40 to-black/70 text-white/20">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5" /></svg>
            {expired && <span className="absolute bottom-1 right-1 px-1 py-px rounded bg-black/70 border border-white/10 text-[7px] font-bold uppercase tracking-wider text-white/50">expired</span>}
        </div>
    );
}

// ONE IntersectionObserver shared by every rail tile: with ~150 jobs in
// history, mounting 150 <video>s on load stampedes the network (and every
// expired link waits out a slow failure first). A tile only gets its <video>
// once scrolled into view (~7 visible), and is unobserved after that.
const tileCallbacks = new WeakMap(); // element → set-in-view callback
let tileObserver = null;
function observeTile(el, cb) {
    if (typeof IntersectionObserver === 'undefined') { cb(); return undefined; }
    tileObserver ||= new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            tileObserver.unobserve(e.target);
            tileCallbacks.get(e.target)?.();
            tileCallbacks.delete(e.target);
        }
    }, { rootMargin: '100px' });
    tileCallbacks.set(el, cb);
    tileObserver.observe(el);
    return () => { tileCallbacks.delete(el); tileObserver.unobserve(el); };
}

// Rail tile video: placeholder until the tile scrolls into view AND a frame
// is decodable — black-void tiles were dead links rendering nothing. A link
// already ~20h+ old is never attached at all: straight to the one-shot
// refresh instead of waiting out the network failure.
function RailVideo({ job, onRefresh }) {
    const [ready, setReady] = useState(false);
    const [inView, setInView] = useState(false);
    const ref = useRef(null);
    useEffect(() => observeTile(ref.current, () => setInView(true)), []);
    useEffect(() => { setReady(false); }, [job.videoUrl]); // a refreshed URL reloads from scratch
    const stale = isStaleUrl(job);
    useEffect(() => {
        if (inView && stale) onRefresh(job, { fromError: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inView, stale]);
    return (
        <div ref={ref} className="absolute inset-0">
            {inView && !stale && (
                <video src={job.videoUrl} muted playsInline preload="metadata" onLoadedData={() => setReady(true)} onError={() => onRefresh(job, { fromError: true })} className="w-full h-full object-cover bg-black" />
            )}
            {!ready && <TilePlaceholder />}
        </div>
    );
}

// Right-side history rail (higgsfield-style): every generation as a compact
// thumbnail — click to play it big on the center stage.
function HistoryRail({ jobs, selectedId, onSelect, onRemove, onToggleLike, onRefresh }) {
    // Only mount a window of tiles (each already lazy-loads its own video via
    // IntersectionObserver); grow the window as the rail scrolls so 100+ videos
    // never mount at once.
    const [visibleCount, setVisibleCount] = useState(24);
    const shown = jobs.slice(0, visibleCount);
    const onScroll = (e) => {
        const el = e.currentTarget;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 260) {
            setVisibleCount((c) => (c < jobs.length ? c + 24 : c));
        }
    };
    return (
        <div className="fixed right-3 top-14 bottom-40 z-20 hidden sm:flex w-44 flex-col">
            <p className="px-1 pb-2 text-[10px] font-bold uppercase tracking-wider text-white/30">History · {jobs.length}</p>
            <div onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar flex flex-col gap-2 pr-0.5">
                {shown.map((job) => {
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
                            {job.status === 'done' && job.imageUrl ? (
                                <img src={job.imageUrl} alt="" loading="lazy" className="w-full h-full object-cover bg-black" />
                            ) : job.status === 'done' && job.videoUrl && !job.expired ? (
                                <RailVideo job={job} onRefresh={onRefresh} />
                            ) : job.status === 'done' ? (
                                <TilePlaceholder expired={!!job.expired} />
                            ) : (
                                <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-black/50 px-2 text-center">
                                    {active ? (
                                        <>
                                            <span className="animate-spin inline-block text-primary text-sm">◌</span>
                                            <span className="text-[9px] font-semibold text-white/50">{STATUS_TEXT[job.status]}</span>
                                        </>
                                    ) : (
                                        <span className="text-[9px] text-danger leading-tight line-clamp-3" title={job.error || undefined}>{friendlyError(job.error) || 'Failed'}</span>
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
                {visibleCount < jobs.length && (
                    <button
                        type="button"
                        onClick={() => setVisibleCount((c) => Math.min(jobs.length, c + 24))}
                        className="shrink-0 rounded-lg border border-line py-2 text-[10px] font-semibold text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink-2"
                    >
                        Load {Math.min(24, jobs.length - visibleCount)} more
                    </button>
                )}
            </div>
            <p className="pt-2 px-1 text-[9px] leading-relaxed text-white/20">Synced to your account · videos auto-archived to team storage</p>
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
            <h1 className="text-3xl sm:text-5xl md:text-6xl font-extrabold font-display text-white tracking-tight mb-4 text-center px-4 leading-[1.05]">
                <span className="text-white/40 font-medium">START CREATING WITH</span><br />
                <span className="text-white">LOGLINEAI STUDIO</span>
            </h1>
            <p className="text-white/40 text-sm md:text-base font-medium tracking-wide text-center max-w-lg leading-relaxed">
                Turn text, images, or references into cinematic AI video — governed, budgeted, and shared with your team.
            </p>
        </div>
    );
}

// Full-screen "big preview" for a finished generation (Higgsfield-style):
// the video fills the left; a right panel carries the prompt, reference
// thumbnails, generation details and the reuse / download / like actions.
function AssetViewer({ job, onClose, onReuse, onToggleLike, onRefresh, onPrev, onNext }) {
    const modelName = job.model ? (MODELS.find((m) => m.id === job.model)?.name ?? IMAGE_MODELS.find((m) => m.id === job.model)?.name ?? job.model) : null;
    const prompt = job.userPrompt || job.prompt || '';
    const created = job.createdAt ? new Date(job.createdAt) : null;
    const createdText = created && !Number.isNaN(created.getTime())
        ? created.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
        : null;

    useEffect(() => {
        const onKey = (e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowLeft') onPrev?.();
            else if (e.key === 'ArrowRight') onNext?.();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose, onPrev, onNext]);

    return (
        <div className="fixed inset-0 z-[80] flex flex-col bg-app-bg animate-fade-in-up lg:flex-row">
            {/* LEFT — video or image */}
            <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
                {job.imageUrl ? (
                    <img key={job.id} src={job.imageUrl} alt={job.prompt || 'Generated image'} className="max-h-full max-w-full object-contain" />
                ) : (
                    <video
                        key={job.id}
                        src={job.videoUrl}
                        controls
                        autoPlay
                        loop
                        playsInline
                        onError={onRefresh}
                        className="max-h-full max-w-full object-contain"
                    />
                )}
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close preview"
                    className="absolute left-4 top-4 rounded-full border border-white/10 bg-black/60 p-2 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white lg:hidden"
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
                {onPrev && (
                    <button type="button" onClick={onPrev} aria-label="Previous" className="absolute left-3 sm:left-5 top-1/2 -translate-y-1/2 z-10 rounded-full border border-white/10 bg-black/60 p-2.5 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                    </button>
                )}
                {onNext && (
                    <button type="button" onClick={onNext} aria-label="Next" className="absolute right-3 sm:right-5 top-1/2 -translate-y-1/2 z-10 rounded-full border border-white/10 bg-black/60 p-2.5 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                    </button>
                )}
            </div>

            {/* RIGHT — info + actions */}
            <aside className="flex w-full shrink-0 flex-col border-t border-line bg-paper-1 lg:h-full lg:w-[360px] lg:border-l lg:border-t-0">
                <div className="flex items-center justify-between border-b border-line px-4 py-3">
                    <div className="flex items-center gap-2">
                        <span className="grid h-7 w-7 place-items-center rounded-full bg-accent font-display text-xs font-bold text-accent-ink">S</span>
                        <div className="leading-tight">
                            <div className="text-xs font-semibold text-ink">Your generation</div>
                            <div className="text-[11px] text-ink-3">{job.mediaType === 'image' ? (modelName || 'Nano Banana') : 'Seedance 2.0'}</div>
                        </div>
                    </div>
                    <button type="button" onClick={onClose} aria-label="Close preview" className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto custom-scrollbar">
                    <section className="border-b border-line px-4 py-3">
                        <div className="mb-2 flex items-center justify-between">
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Prompt</span>
                            {prompt && (
                                <button type="button" onClick={() => navigator.clipboard?.writeText(prompt)} className="text-[11px] font-medium text-ink-3 transition-colors hover:text-ink">Copy</button>
                            )}
                        </div>
                        {prompt
                            ? <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-2">{prompt}</p>
                            : <p className="text-xs text-ink-3">No prompt recorded for this generation.</p>}
                    </section>

                    {job.refs?.length > 0 && (
                        <div className="border-b border-line">
                            {/* No per-section Reuse button here — the "Reuse this
                                setup" action below already restores refs + prompt. */}
                            <RefAssets refs={job.refs} />
                        </div>
                    )}

                    <section className="px-4 py-3">
                        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Details</div>
                        <dl className="space-y-2 text-xs">
                            {modelName && <DetailRow k="Model" v={modelName} />}
                            {job.meta && <DetailRow k="Output" v={job.meta} />}
                            {createdText && <DetailRow k="Created" v={createdText} />}
                            {job.taskId && <DetailRow k="Task" v={<span className="break-all font-mono text-[10px]">{job.taskId}</span>} />}
                        </dl>
                    </section>
                </div>

                <div className="space-y-2 border-t border-line p-3">
                    <button
                        type="button"
                        onClick={() => { onReuse(job, job.refs || []); onClose(); }}
                        title="Load this prompt, references and settings back into the prompt bar"
                        className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2.5 text-xs font-semibold text-accent-ink transition-colors hover:bg-accent-hi"
                    >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 4v6h6M23 20v-6h-6" /><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" /></svg>
                        Reuse this setup
                    </button>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => downloadAsset(job.videoUrl || job.imageUrl, job.taskId || 'generation', job.taskId)}
                            className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-line px-3 py-2.5 text-xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink"
                        >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
                            Download
                        </button>
                        {onToggleLike && (
                            <button
                                type="button"
                                onClick={() => onToggleLike(job.id)}
                                title={job.liked ? 'Unlike' : 'Like'}
                                className={`rounded-md border px-3 py-2.5 transition-colors ${job.liked ? 'border-danger/40 bg-danger/10 text-danger' : 'border-line text-ink-3 hover:bg-paper-3 hover:text-ink'}`}
                            >
                                <svg width="15" height="15" viewBox="0 0 24 24" fill={job.liked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" /></svg>
                            </button>
                        )}
                    </div>
                </div>
            </aside>
        </div>
    );
}

function DetailRow({ k, v }) {
    return (
        <div className="flex items-start justify-between gap-3">
            <dt className="shrink-0 text-ink-3">{k}</dt>
            <dd className="text-right font-medium text-ink-2">{v}</dd>
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
