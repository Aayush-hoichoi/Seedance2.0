'use client';

// Try-On — Lucy-style (lucy.decart.ai) virtual try-on as a studio tool.
// 1. Pick Image or Video, pick the model (same catalogs as the studio), then
//    get a character on the canvas: generate from a prompt, or upload.
// 2. Upload asset images (clothing, props, artwork) into the shelf.
// 3. Drag an asset onto the character — this is COMPLETELY IN-HOUSE: the item
//    becomes a movable, resizable overlay on the canvas. Place it, resize it,
//    swap it, remove it — nothing is generated and nothing is billed.
// 4. Submit final → the one paid step: the AI turns the rough placement into
//    the real result (image model for image characters, a Seedance reference
//    edit for video characters). Only a COMPLETED submission lands in the
//    History section below — in-flight or failed ones never do.
// Billing/access rides the existing generation pipelines untouched: images go
// through POST /api/generations (gateway quota + budgets), video through the
// ModelArk proxy.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Clapperboard, History, ImagePlus, Loader2, Shirt, Sparkles, Undo2, Upload, Wand2, X } from 'lucide-react';
import ProjectSelect from '../../seedance/ProjectSelect.jsx';
import ToolAccessGate, { BudgetChip, useToolStatus } from '../ToolAccessGate.jsx';
import { IMAGE_MODELS, MODELS } from '../../../lib/seedance/constants.js';
import { buildPayload, createTask, pollTask } from '../../../lib/seedance/client.js';
import { registerAssetFromUrl } from '../../../lib/seedance/assetsClient.js';
import { uploadToCdn } from '../../../lib/seedance/upload.js';
import { resolveProjectId, rememberProjectId } from '../../../lib/seedance/projectChoice.mjs';

const DEFAULT_IMAGE_MODEL_ID = 'nano-banana-2'; // open image model
const MINI_VIDEO_MODEL_ID = MODELS.find((m) => m.kind === 'mini').id; // open video tier
const MAX_OVERLAYS = 2; // character + 2 refs stays inside Nano Banana 2's 3-image cap

// Submit-final prompt for IMAGE characters: Image 1 is the flattened canvas —
// the character with the item(s) roughly pasted where the user placed them —
// so the model keeps the user's placement; the remaining images are the clean
// product shots of the same items.
const COMPOSITE_PROMPT = `Virtual try-on finalisation. Image 1 shows a character with item image(s) roughly pasted on top as flat stickers — the position and size of each sticker is where the user wants that item. The following image(s) are the clean product shots of those same items.
Redraw Image 1 as one photorealistic image: every pasted item becomes real — clothing is worn naturally (fitted fabric, folds, correct lighting and shadows), objects/props/artwork sit naturally in the scene — at the position and scale of its sticker.
Keep the character's face, identity, hair, pose, body and the background exactly as in Image 1, and remove every sticker edge and pasted-on look. Change nothing else.`;

// Fallback when the canvas can't be flattened (URL-only character): the refs
// go over separately and placement is left to the model.
const MERGE_PROMPT = `Virtual try-on. Image 1 is the character, the following image(s) are the item(s).
Put each item onto the character: clothing is worn naturally with realistic fabric folds, lighting and shadows; an object, prop or artwork is placed naturally with the character (held, worn, or set into the scene).
Keep the character's face, identity, hair, pose, body and the background from Image 1 exactly unchanged — change ONLY what the items add. Output a single photorealistic image.`;

const VIDEO_MERGE_PROMPT = `Virtual try-on video edit. Video 1 is the character performance, the following image(s) are the item(s).
Recreate Video 1 exactly — same person, same motion, same timing, same camera, same background — with ONE change: the item(s) are now on the character. Clothing is worn throughout, moving naturally with the body; an object, prop or artwork is placed naturally with them in the scene.
Nothing else may change: no added motion, no altered identity, no new background.`;

const ANIMATE_PROMPT = 'The character comes to life: stands up (if seated) and moves naturally and confidently — subtle realistic body motion, the clothing moves with them. Keep the identity, outfit, lighting and background exactly as the image. Smooth, stable camera.';

export default function TryOnClient() {
    const [projects, setProjects] = useState([]);
    const [projectId, setProjectId] = useState(null);
    const [projectsError, setProjectsError] = useState(null);
    // The user's studio model access in this project (grants + overrides from
    // /api/models) — it carries over here 1:1: anything already unlocked in the
    // studio is usable in Try-On with NO extra request; the rest shows locked.
    // null = unknown (loading / pre-migration) → everything stays selectable
    // and the server remains the enforcer, the behaviour before this filter.
    const [modelAccess, setModelAccess] = useState(null);
    const { status, error: statusError, refresh } = useToolStatus('tryon', projectId);

    useEffect(() => {
        fetch('/api/projects')
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Could not load projects (${r.status}).`))))
            .then((d) => {
                const items = Array.isArray(d?.items) ? d.items : [];
                setProjects(items);
                setProjectId(resolveProjectId(items, window.location.search, window.localStorage));
            })
            .catch((e) => setProjectsError(e.message));
    }, []);

    useEffect(() => {
        if (!projectId) return undefined;
        let alive = true;
        setModelAccess(null);
        fetch(`/api/models?projectId=${projectId}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                if (!alive || !Array.isArray(d?.items)) return;
                const allowed = d.items.filter((i) => i.allowed);
                setModelAccess({
                    // Image models match by their alias id; video grants are keyed
                    // by stable alias, so those match through the model's `kind`.
                    ids: new Set(allowed.map((i) => i.id)),
                    kinds: new Set(allowed.map((i) => i.kind).filter(Boolean)),
                });
            })
            .catch(() => { /* unknown access — leave everything selectable */ });
        return () => { alive = false; };
    }, [projectId]);

    const pickProject = (id) => { setProjectId(id); rememberProjectId(id, window.localStorage); };

    return (
        <div className="min-h-screen w-full bg-app-bg px-4 py-6 text-ink sm:px-8">
            <div className="mx-auto max-w-6xl">
                <header className="mb-6 flex flex-wrap items-center gap-3">
                    <Link href="/seedance" title="Back to the studio" className="grid h-7 w-7 place-items-center rounded-md border border-line bg-paper-2 text-ink-3 transition-colors hover:text-ink">
                        <ArrowLeft size={14} />
                    </Link>
                    <h1 className="font-display text-xl font-semibold">Try-On</h1>
                    <span className="rounded-full border border-line px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">drag &amp; drop</span>
                    <div className="ml-auto flex items-center gap-2">
                        {status?.allowed && <BudgetChip budget={status.budget} />}
                        {projects.length > 0 && <ProjectSelect projects={projects} value={projectId} onChange={pickProject} />}
                    </div>
                </header>
                {projectsError
                    ? <div className="text-xs text-danger">{projectsError}</div>
                    : (
                        <ToolAccessGate toolName="Try-On" status={status} error={statusError} projectId={projectId} onChanged={refresh} needsToolBudget={false}>
                            <TryOnWorkspace projectId={projectId} modelAccess={modelAccess} />
                        </ToolAccessGate>
                    )}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Image helpers

// Downscale to ~1024px JPEG for inline delivery (same budget as the studio's
// reference images — a few inline refs stay well under the request body cap).
async function fileToInline(file, maxDim = 1024) {
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
    return { ...parseDataUrl(dataUrl), aspect: w / h };
}

function parseDataUrl(dataUrl) {
    const m = /^data:(.*?);base64,(.*)$/.exec(dataUrl);
    if (!m) throw new Error('Could not encode the image.');
    return { mimeType: m[1], b64: m[2], dataUrl };
}

// Character images coming back from the gateway may be a URL instead of
// inline bytes — pull them local so later steps can send them inline.
async function urlToInline(url) {
    if (url.startsWith('data:')) return parseDataUrl(url);
    const blob = await (await fetch(url)).blob();
    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read the image.'));
        reader.readAsDataURL(blob);
    });
    return parseDataUrl(dataUrl);
}

function loadImageEl(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Could not load the image.'));
        img.src = src;
    });
}

// Flatten the canvas: character image with every overlay drawn at its placed
// fractional position/size — the composite the final submission sends so the
// model respects the user's placement. Throws on a tainted canvas (URL-only
// character), which the caller turns into the no-composite fallback.
async function flattenComposite(character, overlays, maxDim = 1024) {
    const base = await loadImageEl(character.dataUrl);
    const scale = Math.min(1, maxDim / Math.max(base.naturalWidth, base.naturalHeight));
    const W = Math.max(1, Math.round(base.naturalWidth * scale));
    const H = Math.max(1, Math.round(base.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(base, 0, 0, W, H);
    for (const o of overlays) {
        const el = await loadImageEl(o.asset.dataUrl);
        const w = o.w * W;
        const h = w / (o.asset.aspect || (el.naturalWidth / el.naturalHeight) || 1);
        ctx.drawImage(el, o.x * W, o.y * H, w, h);
    }
    return parseDataUrl(canvas.toDataURL('image/jpeg', 0.85));
}

// Re-encode a result small enough for localStorage history.
async function shrinkDataUrl(dataUrl, maxDim = 1024, quality = 0.8) {
    const img = await loadImageEl(dataUrl);
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
}

// Submit one image generation and poll it to a displayable image.
// Returns { mimeType, b64, dataUrl } (inline whenever the provider allows).
async function runImageJob({ projectId, modelId, prompt, refs = [] }) {
    const request = refs.length
        ? { prompt, parts: [{ text: prompt }, ...refs.map((r) => ({ inlineData: { mimeType: r.mimeType, data: r.b64 } }))] }
        : { prompt };
    // Lowest tier the model offers (Seedream's floor is 2K, Banana's is 1K) —
    // the try-on canvas doesn't need more, and the animation is 720p anyway.
    const imageSize = IMAGE_MODELS.find((m) => m.id === modelId)?.resolutions?.[0] ?? null;
    const res = await fetch('/api/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            projectId, modelId, request,
            // mode: the generation_ledger surfaces it as 'Mode / Style', which
            // is what the console's Try-On ledger tab filters on.
            options: { imageCount: 1, aspectRatio: '3:4', imageSize, mode: 'tryon' },
        }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.generationId) {
        throw new Error(data?.error?.message || data?.message || `The image generation could not start (${res.status}).`);
    }
    const MAX_ATTEMPTS = 225; // ~15 min at 4s — same ceiling as the studio
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        let d = null;
        try {
            const poll = await fetch(`/api/generations/${data.generationId}`);
            d = poll.ok ? await poll.json() : null;
        } catch { continue; }
        if (!d) continue;
        if (d.status === 'succeeded') {
            const img = d.result?.images?.[0];
            if (!img) throw new Error('The image finished but came back empty.');
            if (img.b64) return parseDataUrl(`data:${img.mimeType || 'image/png'};base64,${img.b64}`);
            let url = img.url || null;
            if (!url && img.key) {
                const r = await fetch(`/api/byteplus/archive?key=${encodeURIComponent(img.key)}`);
                url = r.ok ? (await r.json())?.url : null;
            }
            if (!url) throw new Error('The image finished but could not be loaded.');
            // ponytail: cross-origin fetch of a signed URL can fail CORS — then
            // the image still displays but can't feed the next step inline.
            try { return await urlToInline(url); } catch { return { mimeType: null, b64: null, dataUrl: url }; }
        }
        if (['failed', 'cancelled', 'timed_out'].includes(d.status)) {
            throw new Error(d.error?.message || 'The image generation failed.');
        }
    }
    throw new Error('Timed out waiting for the image.');
}

// ---------------------------------------------------------------------------
// History — completed final submissions only, persisted locally (the same
// localStorage pattern the studio history uses; quota failures lose
// persistence, never the session).
// ponytail: image entries store a re-encoded ~1024px JPEG, capped at 12
// entries, to stay inside the localStorage quota; a server-backed table is the
// upgrade path if history must follow the user across devices.

const HISTORY_KEY = 'tryon.history.v1';
const HISTORY_MAX = 12;

function loadHistory() {
    try {
        const arr = JSON.parse(window.localStorage.getItem(HISTORY_KEY) || '[]');
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

function persistHistory(entries) {
    try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_MAX))); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Workspace

// A model the user may submit: open tiers always; gated tiers when the
// project's access answer unlocks them (by alias id or stable kind).
function modelAllowed(m, modelAccess) {
    if (!m.gated || !modelAccess) return true;
    return modelAccess.ids.has(m.id) || (m.kind && modelAccess.kinds.has(m.kind));
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function TryOnWorkspace({ projectId, modelAccess }) {
    // character: { kind:'image', mimeType, b64, dataUrl } or
    //            { kind:'video', url, assetUrl? } (assetUrl = cached asset:// ref)
    const [character, setCharacter] = useState(null);
    const [versions, setVersions] = useState([]); // older character states, newest first
    const [assets, setAssets] = useState([]); // { name, mimeType, b64, dataUrl, aspect }
    // In-house placement layer: items dropped on the canvas. Free — no AI, no
    // budget — until Submit final sends them for generation.
    const [overlays, setOverlays] = useState([]); // { id, asset, x, y, w } (fractions of the canvas)
    const [charPrompt, setCharPrompt] = useState('');
    const [charKind, setCharKind] = useState('image'); // what Generate creates
    const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL_ID);
    const [videoModel, setVideoModel] = useState(MINI_VIDEO_MODEL_ID);
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(null); // 'character' | 'final' | 'animate'
    const [error, setError] = useState(null);
    const [dragOver, setDragOver] = useState(false);
    const [video, setVideo] = useState(null); // { url } — animation of an image character
    const [showVideo, setShowVideo] = useState(false);
    const [history, setHistory] = useState([]);
    const charInputRef = useRef(null);
    const assetInputRef = useRef(null);
    const canvasRef = useRef(null);
    const gestureRef = useRef(null); // { id, mode:'move'|'resize', startX, startY, origX, origY, origW }

    useEffect(() => { setHistory(loadHistory()); }, []);

    const run = async (kind, fn) => {
        if (busy) return;
        setBusy(kind);
        setError(null);
        try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(null); }
    };

    // If a remembered/selected model turns out locked in this project, snap to
    // the open defaults rather than letting the submit fail after the wait.
    useEffect(() => {
        if (!modelAccess) return;
        const img = IMAGE_MODELS.find((m) => m.id === imageModel);
        if (img && !modelAllowed(img, modelAccess)) setImageModel(DEFAULT_IMAGE_MODEL_ID);
        const vid = MODELS.find((m) => m.id === videoModel);
        if (vid && !modelAllowed(vid, modelAccess)) setVideoModel(MINI_VIDEO_MODEL_ID);
    }, [modelAccess, imageModel, videoModel]);

    const replaceCharacter = (next) => {
        setVersions((v) => (character ? [character, ...v].slice(0, 8) : v));
        setCharacter(next);
        setOverlays([]);
        setVideo(null);
        setShowVideo(false);
    };

    const recordFinal = async (entry) => {
        const full = { id: `fin-${Date.now().toString(36)}`, projectId, createdAt: Date.now(), ...entry };
        setHistory((prev) => {
            const next = [full, ...prev].slice(0, HISTORY_MAX);
            persistHistory(next);
            return next;
        });
    };

    const deleteHistory = (id) => {
        setHistory((prev) => {
            const next = prev.filter((h) => h.id !== id);
            persistHistory(next);
            return next;
        });
    };

    const videoOptions = (overrides = {}) => ({
        model: videoModel, ratio: 'adaptive', resolution: '720p', duration: 5,
        generate_audio: false, watermark: false, seed: -1, ...overrides,
    });

    const generateCharacter = () => run('character', async () => {
        const p = charPrompt.trim();
        if (!p) throw new Error(`Describe the character ${charKind} you want to create.`);
        const prompt = `Full-body photorealistic shot of a character, standing, facing the camera, clean simple background, soft studio lighting. ${p}`;
        if (charKind === 'image') {
            const img = await runImageJob({ projectId, modelId: imageModel, prompt });
            replaceCharacter({ kind: 'image', ...img });
        } else {
            const payload = buildPayload({
                options: videoOptions({ ratio: '3:4' }),
                prompt: `${prompt} The character moves subtly and naturally; stable camera.`,
                mediaItems: [],
            });
            const { id } = await createTask(payload, 'tryon', projectId);
            const { url } = await pollTask(id);
            replaceCharacter({ kind: 'video', url });
        }
    });

    const uploadCharacter = (file) => run('character', async () => {
        if (file?.type?.startsWith('image/')) {
            const img = await fileToInline(file);
            replaceCharacter({ kind: 'image', ...img });
        } else if (file?.type?.startsWith('video/')) {
            // Video needs a real URL (ModelArk takes no data: videos) — reuse the
            // CDN upload the Upscale tool uses.
            const { url } = await uploadToCdn(file);
            replaceCharacter({ kind: 'video', url });
        } else {
            throw new Error('Pick an image or video file.');
        }
    });

    const addAssets = async (files) => {
        setError(null);
        const added = [];
        for (const file of Array.from(files || []).filter((f) => f.type?.startsWith('image/'))) {
            try {
                const img = await fileToInline(file);
                const a = { name: file.name, ...img };
                added.push(a);
                setAssets((prev) => [...prev, a]);
            } catch { /* unreadable image — skip */ }
        }
        return added;
    };

    // ------------------------------------------------------------------
    // In-house placement (free): drop/click an asset → overlay on the canvas.

    const addOverlay = (asset, x = 0.3, y = 0.3) => {
        setError(null);
        if (!character) { setError('Add a character first, then drop items on it.'); return; }
        setOverlays((prev) => {
            if (prev.length >= MAX_OVERLAYS) {
                setError(`Up to ${MAX_OVERLAYS} items per submission — remove one first.`);
                return prev;
            }
            const w = 0.35;
            return [...prev, { id: `ov-${Date.now().toString(36)}-${prev.length}`, asset, x: clamp(x - w / 2, 0, 0.9), y: clamp(y - 0.1, 0, 0.9), w }];
        });
        setShowVideo(false);
    };

    const canvasPoint = (e) => {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return { x: 0.3, y: 0.3, rect: null };
        return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height, rect };
    };

    const onDrop = (e) => {
        e.preventDefault();
        setDragOver(false);
        if (busy) return;
        const { x, y } = canvasPoint(e);
        if (e.dataTransfer.files?.length) {
            // A file dragged straight from the OS: if there's no character yet it
            // becomes the character, otherwise it joins the shelf and is placed.
            const file = e.dataTransfer.files[0];
            if (!character) { uploadCharacter(file); return; }
            addAssets([file]).then(([a]) => { if (a) addOverlay(a, x, y); });
            return;
        }
        const idx = Number(e.dataTransfer.getData('text/x-tryon-asset'));
        if (Number.isInteger(idx) && assets[idx]) addOverlay(assets[idx], x, y);
    };

    const startGesture = (e, id, mode) => {
        e.preventDefault();
        e.stopPropagation();
        const o = overlays.find((ov) => ov.id === id);
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!o || !rect) return;
        gestureRef.current = { id, mode, rect, startX: e.clientX, startY: e.clientY, origX: o.x, origY: o.y, origW: o.w };
        e.currentTarget.setPointerCapture?.(e.pointerId);
    };

    const moveGesture = (e) => {
        const g = gestureRef.current;
        if (!g) return;
        const dx = (e.clientX - g.startX) / g.rect.width;
        const dy = (e.clientY - g.startY) / g.rect.height;
        setOverlays((prev) => prev.map((o) => {
            if (o.id !== g.id) return o;
            if (g.mode === 'resize') return { ...o, w: clamp(g.origW + dx, 0.08, 1) };
            return { ...o, x: clamp(g.origX + dx, -0.2, 0.95), y: clamp(g.origY + dy, -0.1, 0.95) };
        }));
    };

    const endGesture = () => { gestureRef.current = null; };

    // ------------------------------------------------------------------
    // Submit final — the only step that generates (and spends budget). A
    // completed result replaces the canvas AND is recorded in History;
    // in-flight or failed submissions never touch History.

    const submitFinal = () => run('final', async () => {
        if (!character) throw new Error('Add a character first.');
        if (!overlays.length) throw new Error('Drop at least one item on the character first.');
        const extra = note.trim();
        const itemNames = overlays.map((o) => o.asset.name).join(', ');

        if (character.kind === 'video') {
            // The character video must enter as a verified library asset —
            // ModelArk's input scan rejects person footage referenced by raw URL.
            // The asset:// ref is cached on the character for repeat submissions.
            let assetUrl = character.assetUrl;
            if (!assetUrl) {
                const reg = await registerAssetFromUrl({ url: character.url, kind: 'video' });
                assetUrl = reg.url;
                setCharacter((c) => (c?.url === character.url ? { ...c, assetUrl } : c));
            }
            // Reference edits need a model that runs r2v (the 2.0 family) — fall
            // back to the open Mini tier when the picked model can't.
            const model = MODELS.find((m) => m.id === videoModel)?.supportsReference !== false ? videoModel : MINI_VIDEO_MODEL_ID;
            const prompt = extra ? `${VIDEO_MERGE_PROMPT}\nAdditional instruction: ${extra}` : VIDEO_MERGE_PROMPT;
            const payload = buildPayload({
                // duration -1: a video edit inherits the source clip's length.
                options: videoOptions({ model, generate_audio: true, duration: -1 }),
                prompt,
                mediaItems: [
                    { kind: 'video', url: assetUrl, role: 'reference_video' },
                    ...overlays.map((o) => ({ kind: 'image', url: o.asset.dataUrl, role: 'reference_image' })),
                ],
            });
            const { id } = await createTask(payload, 'tryon', projectId);
            const { url } = await pollTask(id);
            replaceCharacter({ kind: 'video', url });
            await recordFinal({ kind: 'video', url, model: MODELS.find((m) => m.id === model)?.name || model, items: itemNames });
            return;
        }

        // Image character: flatten the placement into a composite so the model
        // keeps the user's position/size; fall back to separate refs when the
        // canvas is tainted (URL-only character).
        let refs;
        let prompt;
        try {
            const composite = await flattenComposite(character, overlays);
            refs = [composite, ...overlays.map((o) => o.asset)];
            prompt = extra ? `${COMPOSITE_PROMPT}\nAdditional instruction: ${extra}` : COMPOSITE_PROMPT;
        } catch {
            const base = character.b64 ? character : await urlToInline(character.dataUrl)
                .catch(() => { throw new Error('This image can’t be reused directly — download it and upload it as the character.'); });
            refs = [base, ...overlays.map((o) => o.asset)];
            prompt = extra ? `${MERGE_PROMPT}\nAdditional instruction: ${extra}` : MERGE_PROMPT;
        }
        const img = await runImageJob({ projectId, modelId: imageModel, prompt, refs });
        replaceCharacter({ kind: 'image', ...img });
        const thumb = await shrinkDataUrl(img.dataUrl).catch(() => null);
        await recordFinal({ kind: 'image', thumb: thumb || img.dataUrl, model: IMAGE_MODELS.find((m) => m.id === imageModel)?.name || imageModel, items: itemNames });
    });

    const animate = () => run('animate', async () => {
        if (character?.kind !== 'image') throw new Error('Add an image character first.');
        const payload = buildPayload({
            options: videoOptions(),
            prompt: ANIMATE_PROMPT,
            mediaItems: [{ kind: 'image', url: character.dataUrl, role: 'first_frame' }],
        });
        const { id } = await createTask(payload, 'tryon', projectId);
        const { url } = await pollTask(id);
        setVideo({ url });
        setShowVideo(true);
        await recordFinal({ kind: 'video', url, model: MODELS.find((m) => m.id === videoModel)?.name || videoModel, items: 'Animation' });
    });

    const undo = () => {
        if (!versions.length || busy) return;
        setCharacter(versions[0]);
        setVersions((v) => v.slice(1));
        setOverlays([]);
        setVideo(null);
        setShowVideo(false);
    };

    const reuseFromHistory = (h) => {
        if (busy) return;
        setError(null);
        if (h.kind === 'image') {
            try { replaceCharacter({ kind: 'image', ...parseDataUrl(h.thumb) }); } catch { setError('Could not load that result.'); }
        } else {
            replaceCharacter({ kind: 'video', url: h.url });
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const projectHistory = history.filter((h) => !h.projectId || !projectId || h.projectId === projectId);

    return (
        <>
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem] lg:items-start">
            {/* Character canvas */}
            <section className="flex flex-col gap-3">
                <div
                    ref={canvasRef}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={onDrop}
                    onPointerMove={moveGesture}
                    onPointerUp={endGesture}
                    onPointerLeave={endGesture}
                    className={`relative mx-auto flex aspect-[3/4] w-full max-w-md items-center justify-center overflow-hidden rounded-xl border bg-paper-2 transition-colors ${dragOver ? 'border-accent ring-2 ring-accent/40' : 'border-line'}`}
                >
                    {showVideo && video ? (
                        <video src={video.url} controls autoPlay loop playsInline className="h-full w-full object-contain bg-black" />
                    ) : character?.kind === 'video' ? (
                        <video src={character.url} controls autoPlay loop playsInline className="h-full w-full object-contain bg-black" />
                    ) : character ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={character.dataUrl} alt="Character" className="h-full w-full object-cover" />
                    ) : (
                        <div className="flex flex-col items-center gap-2 p-6 text-center text-ink-3">
                            <Shirt size={26} />
                            <span className="text-sm font-medium text-ink-2">No character yet</span>
                            <span className="max-w-xs text-xs leading-relaxed">Pick Image or Video below, generate a character or upload one, then drag assets from the shelf onto it.</span>
                        </div>
                    )}

                    {/* In-house placement overlays — free to move/resize/remove */}
                    {!showVideo && overlays.map((o) => (
                        <div key={o.id}
                            onPointerDown={(e) => startGesture(e, o.id, 'move')}
                            style={{ left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: `${o.w * 100}%`, touchAction: 'none' }}
                            className="group absolute cursor-grab active:cursor-grabbing">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={o.asset.dataUrl} alt={o.asset.name} draggable={false}
                                className="w-full rounded-md border border-dashed border-accent/70 opacity-95 shadow-lg" />
                            <button type="button" aria-label="Remove item"
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={() => setOverlays((prev) => prev.filter((p) => p.id !== o.id))}
                                className="absolute -right-2 -top-2 rounded-full border border-line bg-paper-1 p-0.5 text-ink-3 hover:text-danger">
                                <X size={12} />
                            </button>
                            <span aria-hidden
                                onPointerDown={(e) => startGesture(e, o.id, 'resize')}
                                style={{ touchAction: 'none' }}
                                className="absolute -bottom-1.5 -right-1.5 h-4 w-4 cursor-nwse-resize rounded-sm border border-accent bg-paper-1" />
                        </div>
                    ))}

                    {busy && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50 text-white backdrop-blur-[2px]">
                            <Loader2 size={22} className="animate-spin" />
                            <span className="text-xs font-medium">
                                {busy === 'character' ? (charKind === 'video' ? 'Creating the character video… (~1–3 min)' : 'Creating the character…')
                                    : busy === 'final' ? (character?.kind === 'video' ? 'Preparing the final model across the video… (~2–5 min)' : 'Preparing the final model…')
                                        : 'Bringing the character to life… (~1–2 min)'}
                            </span>
                        </div>
                    )}
                    {dragOver && !busy && (
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-accent/20">
                            <span className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-ink">Drop to place it — free until you submit</span>
                        </div>
                    )}
                </div>

                <div className="mx-auto flex w-full max-w-md flex-wrap items-center gap-2">
                    {video && (
                        <button type="button" onClick={() => setShowVideo((s) => !s)}
                            className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink">
                            {showVideo ? 'Show image' : 'Show video'}
                        </button>
                    )}
                    {versions.length > 0 && (
                        <button type="button" onClick={undo} disabled={!!busy}
                            className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-40">
                            <Undo2 size={13} /> Undo
                        </button>
                    )}
                    {character?.kind === 'image' && !overlays.length && (
                        <span className="ml-auto inline-flex items-center gap-2">
                            <ModelSelect kind="video" value={videoModel} onChange={setVideoModel} disabled={!!busy} modelAccess={modelAccess} title="Model used for the animation" />
                            <button type="button" onClick={animate} disabled={!!busy}
                                className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-2 text-xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-40">
                                <Clapperboard size={14} /> Animate (5s video)
                            </button>
                        </span>
                    )}
                    {character && overlays.length > 0 && (
                        <button type="button" onClick={submitFinal} disabled={!!busy}
                            className="ml-auto inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40">
                            <Wand2 size={14} /> Submit final ({overlays.length} item{overlays.length > 1 ? 's' : ''})
                        </button>
                    )}
                </div>

                {character && overlays.length > 0 && !busy && (
                    <p className="mx-auto w-full max-w-md text-[11px] leading-relaxed text-ink-3">
                        Placement is free — move and resize the item(s) as you like. <strong className="font-semibold text-ink-2">Submit final</strong> is the only step that generates (and bills); the finished result is what lands in History below.
                    </p>
                )}

                {error && <p className="mx-auto w-full max-w-md text-xs text-danger">{error}</p>}

                {/* Character sources */}
                <div className="mx-auto flex w-full max-w-md flex-col gap-2 rounded-xl border border-line bg-paper-2 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold text-ink-2">Character</span>
                        <div className="flex overflow-hidden rounded-md border border-line" role="radiogroup" aria-label="Character media type">
                            {['image', 'video'].map((k) => (
                                <button key={k} type="button" onClick={() => setCharKind(k)} disabled={!!busy}
                                    aria-pressed={charKind === k}
                                    className={`px-3 py-1 text-[11px] font-semibold capitalize transition-colors ${charKind === k ? 'bg-accent text-accent-ink' : 'bg-paper-3 text-ink-3 hover:text-ink'}`}>
                                    {k}
                                </button>
                            ))}
                        </div>
                        <span className="ml-auto">
                            {charKind === 'image'
                                ? <ModelSelect kind="image" value={imageModel} onChange={setImageModel} disabled={!!busy} modelAccess={modelAccess} title="Image model" />
                                : <ModelSelect kind="video" value={videoModel} onChange={setVideoModel} disabled={!!busy} modelAccess={modelAccess} title="Video model" />}
                        </span>
                    </div>
                    <div className="flex gap-2">
                        <input value={charPrompt} onChange={(e) => setCharPrompt(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') generateCharacter(); }}
                            placeholder={charKind === 'image'
                                ? 'e.g. a young woman with short black hair, jeans and a white t-shirt'
                                : 'e.g. a young man in a plain t-shirt, standing and talking to the camera'}
                            className="min-w-0 flex-1 rounded-md border border-line bg-paper-3 px-3 py-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent" />
                        <button type="button" onClick={generateCharacter} disabled={!!busy || !charPrompt.trim()}
                            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40">
                            <Sparkles size={13} /> Generate {charKind}
                        </button>
                    </div>
                    <input ref={charInputRef} type="file" accept="image/*,video/*" className="hidden"
                        onChange={(e) => { uploadCharacter(e.target.files?.[0]); e.target.value = ''; }} />
                    <button type="button" onClick={() => charInputRef.current?.click()} disabled={!!busy}
                        className="inline-flex items-center justify-center gap-1.5 rounded-md border border-line px-3 py-2 text-xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-40">
                        <Upload size={13} /> Or upload a character photo / video
                    </button>
                </div>
            </section>

            {/* Asset shelf */}
            <aside className="flex flex-col gap-3 rounded-xl border border-line bg-paper-2 p-4 lg:sticky lg:top-6">
                <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">Assets</span>
                    <span className="text-[11px] text-ink-3">drag onto the character</span>
                </div>
                <input ref={assetInputRef} type="file" accept="image/*" multiple className="hidden"
                    onChange={(e) => { addAssets(e.target.files); e.target.value = ''; }} />
                <button type="button" onClick={() => assetInputRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); addAssets(e.dataTransfer.files); }}
                    className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-line px-3 py-5 text-ink-3 transition-colors hover:border-accent/50 hover:text-ink-2">
                    <ImagePlus size={18} />
                    <span className="text-xs font-medium">Upload asset images</span>
                    <span className="text-[10px]">clothing · props · artwork</span>
                </button>
                {assets.length > 0 && (
                    <ul className="grid grid-cols-3 gap-2">
                        {assets.map((a, i) => (
                            <li key={`${a.name}-${i}`} className="group relative">
                                <button type="button" title={`${a.name} — drag onto the character, or click to place it`}
                                    draggable
                                    onDragStart={(e) => { e.dataTransfer.setData('text/x-tryon-asset', String(i)); e.dataTransfer.effectAllowed = 'copy'; }}
                                    onClick={() => addOverlay(a)}
                                    disabled={!!busy || !character}
                                    className="block w-full cursor-grab overflow-hidden rounded-lg border border-line transition-colors hover:border-accent/60 active:cursor-grabbing disabled:cursor-default disabled:opacity-60">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={a.dataUrl} alt={a.name} className="aspect-square w-full object-cover" />
                                </button>
                                <button type="button" aria-label={`Remove ${a.name}`}
                                    onClick={() => setAssets((prev) => prev.filter((_, idx) => idx !== i))}
                                    className="absolute -right-1.5 -top-1.5 hidden rounded-full border border-line bg-paper-1 p-0.5 text-ink-3 hover:text-danger group-hover:block">
                                    <X size={11} />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-semibold text-ink-2">Final instruction <span className="font-normal text-ink-3">(optional)</span></span>
                    <input value={note} onChange={(e) => setNote(e.target.value)}
                        placeholder="e.g. wear it open, over the t-shirt"
                        className="rounded-md border border-line bg-paper-3 px-3 py-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent" />
                </label>
                <p className="text-[11px] leading-relaxed text-ink-3">
                    Dragging, placing and resizing are completely in-house and free — no budget is used. Only <strong className="font-semibold text-ink-2">Submit final</strong> (and Generate/Animate) runs a model, billed to this project like any studio generation.
                </p>
            </aside>
        </div>

        {/* History — completed final submissions only */}
        <section className="mt-10">
            <div className="mb-3 flex items-center gap-2">
                <History size={15} className="text-accent-hi" />
                <h2 className="text-sm font-semibold">History — final submissions</h2>
                <span className="text-[11px] text-ink-3">only completed results are listed · stored on this device</span>
            </div>
            {!projectHistory.length ? (
                <p className="rounded-xl border border-line bg-paper-2 p-5 text-xs text-ink-3">
                    Nothing here yet. Place an item on a character and press <strong className="font-semibold text-ink-2">Submit final</strong> — the finished result shows up here once it completes.
                </p>
            ) : (
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {projectHistory.map((h) => (
                        <li key={h.id} className="flex flex-col overflow-hidden rounded-xl border border-line bg-paper-2">
                            {h.kind === 'image'
                                // eslint-disable-next-line @next/next/no-img-element
                                ? <img src={h.thumb} alt={h.items || 'Final result'} className="aspect-[3/4] w-full object-cover" />
                                : <video src={h.url} controls preload="metadata" playsInline className="aspect-[3/4] w-full bg-black object-contain" />}
                            <div className="flex flex-col gap-1.5 p-3">
                                <span className="truncate text-xs font-medium text-ink-2" title={h.items}>{h.items || 'Final result'}</span>
                                <span className="text-[11px] text-ink-3">
                                    {h.model} · {new Date(h.createdAt).toLocaleString()}
                                    {h.kind === 'video' ? ' · video link expires in ~24h' : ''}
                                </span>
                                <div className="mt-1 flex gap-2">
                                    <button type="button" onClick={() => reuseFromHistory(h)} disabled={!!busy}
                                        className="rounded-md border border-line px-2.5 py-1 text-[11px] font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-40">
                                        Use as character
                                    </button>
                                    <button type="button" onClick={() => deleteHistory(h.id)}
                                        className="ml-auto rounded-md px-2 py-1 text-[11px] text-ink-3 transition-colors hover:text-danger">
                                        Delete
                                    </button>
                                </div>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </section>
        </>
    );
}

// Model picker, fed by the same catalogs as the studio (image or video).
// Studio access carries over: a gated model the user already has is plainly
// selectable here; one they lack is disabled (request it in the studio once,
// and it unlocks everywhere — never "exclusively for Try-On").
function ModelSelect({ kind, value, onChange, disabled, title, modelAccess }) {
    const models = kind === 'image' ? IMAGE_MODELS : MODELS;
    return (
        <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} title={title}
            className="max-w-[11rem] rounded-md border border-line bg-paper-3 px-2 py-1.5 text-[11px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40">
            {models.map((m) => {
                const allowed = modelAllowed(m, modelAccess);
                return (
                    <option key={m.id} value={m.id} disabled={!allowed}>
                        {m.name}{allowed ? '' : ' — locked (request in studio)'}
                    </option>
                );
            })}
        </select>
    );
}
