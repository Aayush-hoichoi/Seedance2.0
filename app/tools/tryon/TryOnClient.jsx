'use client';

// Try-On — Lucy-style (lucy.decart.ai) virtual try-on as a studio tool.
// 1. Pick Image or Video, pick the model (same catalogs as the studio), then
//    get a character on the canvas: generate from a prompt, or upload.
// 2. Upload asset images (clothing, props, artwork) into the shelf.
// 3. Drag an asset onto the character and the AI places it RIGHT THERE,
//    immediately: the drop point is baked into a flattened composite the
//    model is told to respect, so a cap dropped on the head sits on the head
//    at that exact spot, blended realistically. (Video characters run a
//    Seedance reference edit instead — no spatial pin there.) Each drop is
//    one generation, billed like any studio generation.
// 4. Submit final records the finished look on the canvas into the History
//    section below — only completed, explicitly submitted results appear.
// Billing/access rides the existing generation pipelines untouched: images go
// through POST /api/generations (gateway quota + budgets), video through the
// ModelArk proxy.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Clapperboard, History, ImagePlus, Loader2, Shirt, Sparkles, Undo2, Upload, Wand2, X } from 'lucide-react';
import ProjectSelect from '../../seedance/ProjectSelect.jsx';
import MicButton from '../../seedance/MicButton.jsx';
import ToolAccessGate, { BudgetChip, useToolStatus } from '../ToolAccessGate.jsx';
import { IMAGE_MODELS, MODELS, imageRefMax } from '../../../lib/seedance/constants.js';
import { buildPayload, createTask, pollTask } from '../../../lib/seedance/client.js';
import { registerAssetFromUrl } from '../../../lib/seedance/assetsClient.js';
import { uploadToCdn } from '../../../lib/seedance/upload.js';
import { resolveProjectId, rememberProjectId } from '../../../lib/seedance/projectChoice.mjs';

const DEFAULT_IMAGE_MODEL_ID = 'nano-banana-2'; // open image model
const MINI_VIDEO_MODEL_ID = MODELS.find((m) => m.kind === 'mini').id; // open video tier

// Drop-merge prompt: Image 1 is the flattened canvas — the character with the
// item pasted as a flat sticker at the exact spot the user dropped it — and
// Image 2 the clean product shot. The user's position is the instruction.
const POSITION_PROMPT = `Virtual try-on. Image 1 shows a character with an item image pasted on top as a flat sticker — the sticker's position and size mark EXACTLY where the user wants that item. Image 2 is the clean product shot of the same item.
Redraw Image 1 as one photorealistic image: the pasted item becomes real at that exact position and scale — clothing/headwear/footwear is worn there, fitted to the body part under the sticker (fabric folds, correct wrap and perspective); an object, prop or artwork sits naturally there in the scene. Blend it with matching lighting and contact shadows, and remove every sticker edge and pasted-on look.
Keep the character's face, identity, hair, pose, body and the background exactly as in Image 1. Change nothing else.`;

// Fallback when the canvas can't be flattened (URL-only character): refs go
// over separately and the model places the item where it naturally belongs.
const MERGE_PROMPT = `Virtual try-on. Image 1 is the character, Image 2 is the item to put on them.
Place the item in its correct, natural position for what it is: a cap/hat on the head, shoes on the feet, glasses on the face, a shirt/jacket/dress on the torso, trousers on the legs, a bag held or over the shoulder, artwork hung on the wall. Resize and fit it to the character's pose and perspective, with realistic fabric folds, contact shadows and matching lighting.
Keep the character's face, identity, hair, pose, body and the background from Image 1 exactly unchanged — change ONLY what the item adds. Output a single photorealistic image with no pasted-on look.`;

const VIDEO_MERGE_PROMPT = `Virtual try-on video edit. Video 1 is the character performance, Image 1 is the item.
Recreate Video 1 exactly — same person, same motion, same timing, same camera, same background — with ONE change: the item is now on the character, in its correct natural position for what it is (a cap on the head, shoes on the feet, a jacket worn on the torso, glasses on the face), fitted to the body and moving with it throughout; an object, prop or artwork is placed naturally with them in the scene.
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
            <div className="mx-auto max-w-7xl">
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

// Flatten the character with the dropped item drawn at its fractional drop
// position/size — this composite is what tells the model EXACTLY where the
// user wants the item. Throws on a tainted canvas (URL-only character), which
// the caller turns into the position-less fallback.
async function flattenComposite(character, overlay, maxDim = 1024) {
    const base = await loadImageEl(character.dataUrl);
    const scale = Math.min(1, maxDim / Math.max(base.naturalWidth, base.naturalHeight));
    const W = Math.max(1, Math.round(base.naturalWidth * scale));
    const H = Math.max(1, Math.round(base.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(base, 0, 0, W, H);
    const el = await loadImageEl(overlay.asset.dataUrl);
    const w = overlay.w * W;
    const h = w / (overlay.asset.aspect || (el.naturalWidth / el.naturalHeight) || 1);
    ctx.drawImage(el, overlay.x * W, overlay.y * H, w, h);
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
    // The sticker shown on the canvas while a drop-merge renders — purely
    // visual feedback of where the user dropped; cleared when the result lands.
    const [overlays, setOverlays] = useState([]); // [{ id, asset, x, y, w }] (fractions of the canvas)
    // Item names merged onto the current character since it was created —
    // what a Submit final lists in History.
    const [itemsWorn, setItemsWorn] = useState([]);
    const [charPrompt, setCharPrompt] = useState('');
    // Reference photos attached in the prompt bar — the casting / look-test
    // path: an actor's photo (or several) drives the generated character's
    // identity, and the prompt describes the look to test on them.
    const [charRefs, setCharRefs] = useState([]); // { name, mimeType, b64, dataUrl, aspect }
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
    const charRefInputRef = useRef(null);
    const assetInputRef = useRef(null);
    const canvasRef = useRef(null);

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
        if (!p && !charRefs.length) throw new Error(`Describe the character ${charKind} you want to create — or attach a photo.`);
        setItemsWorn([]); // a fresh character wears nothing yet
        // With reference photos attached (casting / look test), the person in
        // them IS the character — identity locked, the prompt styles the look.
        const prompt = charRefs.length
            ? `Full-body photorealistic shot of the person from the reference photo(s) — keep their face, identity, skin tone, hair and build EXACTLY as in the references. Standing, facing the camera, clean simple background, soft studio lighting. ${p || 'Natural, neutral styling.'}`
            : `Full-body photorealistic shot of a character, standing, facing the camera, clean simple background, soft studio lighting. ${p}`;
        if (charKind === 'image') {
            const img = await runImageJob({ projectId, modelId: imageModel, prompt, refs: charRefs });
            replaceCharacter({ kind: 'image', ...img });
        } else {
            // Reference photos make this an r2v task — needs the 2.0 family;
            // fall back to the open Mini tier when the picked model can't.
            const model = !charRefs.length || MODELS.find((m) => m.id === videoModel)?.supportsReference !== false ? videoModel : MINI_VIDEO_MODEL_ID;
            const payload = buildPayload({
                options: videoOptions({ model, ratio: '3:4' }),
                prompt: `${prompt} The character moves subtly and naturally; stable camera.`,
                mediaItems: charRefs.map((r) => ({ kind: 'image', url: r.dataUrl, role: 'reference_image' })),
            });
            const { id } = await createTask(payload, 'tryon', projectId);
            const { url } = await pollTask(id);
            replaceCharacter({ kind: 'video', url });
        }
    });

    // Prompt-bar photo attachments (capped at the selected image model's
    // reference limit — the tightest consumer).
    const addCharRefs = async (files) => {
        setError(null);
        const cap = imageRefMax(imageModel);
        for (const file of Array.from(files || []).filter((f) => f.type?.startsWith('image/'))) {
            try {
                const img = await fileToInline(file);
                setCharRefs((prev) => (prev.length >= cap ? prev : [...prev, { name: file.name, ...img }]));
            } catch { /* unreadable image — skip */ }
        }
    };

    const uploadCharacter = (file) => run('character', async () => {
        setItemsWorn([]); // a fresh character wears nothing yet
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
    // Drop = generate. The item is merged AT THE DROP POINT, immediately —
    // the drop position is flattened into the composite the model receives.

    const canvasPoint = (e) => {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return { x: 0.5, y: 0.35 };
        return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
    };

    const dropMerge = (asset, x = 0.5, y = 0.35) => run('merge', async () => {
        if (!character) throw new Error('Add a character first, then drop items on it.');
        const w = 0.35; // sticker width as a fraction of the canvas
        const overlay = { id: `ov-${Date.now().toString(36)}`, asset, x: clamp(x - w / 2, 0, 1 - w), y: clamp(y - 0.08, 0, 0.9), w };
        setOverlays([overlay]); // visible under the busy veil while it renders
        setShowVideo(false);
        const extra = note.trim();
        try {
            if (character.kind === 'video') {
                // The character video must enter as a verified library asset —
                // ModelArk's input scan rejects person footage referenced by raw
                // URL. The asset:// ref is cached for repeat merges.
                let assetUrl = character.assetUrl;
                if (!assetUrl) {
                    const reg = await registerAssetFromUrl({ url: character.url, kind: 'video' });
                    assetUrl = reg.url;
                    setCharacter((c) => (c?.url === character.url ? { ...c, assetUrl } : c));
                }
                // Reference edits need a model that runs r2v (the 2.0 family) —
                // fall back to the open Mini tier when the picked model can't.
                const model = MODELS.find((m) => m.id === videoModel)?.supportsReference !== false ? videoModel : MINI_VIDEO_MODEL_ID;
                const prompt = extra ? `${VIDEO_MERGE_PROMPT}\nAdditional instruction: ${extra}` : VIDEO_MERGE_PROMPT;
                const payload = buildPayload({
                    // duration -1: a video edit inherits the source clip's length.
                    options: videoOptions({ model, generate_audio: true, duration: -1 }),
                    prompt,
                    mediaItems: [
                        { kind: 'video', url: assetUrl, role: 'reference_video' },
                        { kind: 'image', url: asset.dataUrl, role: 'reference_image' },
                    ],
                });
                const { id } = await createTask(payload, 'tryon', projectId);
                const { url } = await pollTask(id);
                replaceCharacter({ kind: 'video', url });
            } else {
                // Image character: composite with the sticker at the drop point
                // (the position instruction), plus the clean product shot. Falls
                // back to position-less refs on a tainted canvas.
                let refs;
                let prompt;
                try {
                    const composite = await flattenComposite(character, overlay);
                    refs = [composite, asset];
                    prompt = extra ? `${POSITION_PROMPT}\nAdditional instruction: ${extra}` : POSITION_PROMPT;
                } catch {
                    const base = character.b64 ? character : await urlToInline(character.dataUrl)
                        .catch(() => { throw new Error('This image can’t be reused directly — download it and upload it as the character.'); });
                    refs = [base, asset];
                    prompt = extra ? `${MERGE_PROMPT}\nAdditional instruction: ${extra}` : MERGE_PROMPT;
                }
                const img = await runImageJob({ projectId, modelId: imageModel, prompt, refs });
                replaceCharacter({ kind: 'image', ...img });
            }
            setItemsWorn((prev) => [...prev, asset.name]);
        } finally {
            setOverlays([]);
        }
    });

    const onDrop = (e) => {
        e.preventDefault();
        setDragOver(false);
        if (busy) return;
        const { x, y } = canvasPoint(e);
        if (e.dataTransfer.files?.length) {
            // A file dragged straight from the OS: if there's no character yet it
            // becomes the character, otherwise it joins the shelf and is merged
            // right where it was dropped.
            const file = e.dataTransfer.files[0];
            if (!character) { uploadCharacter(file); return; }
            addAssets([file]).then(([a]) => { if (a) dropMerge(a, x, y); });
            return;
        }
        const idx = Number(e.dataTransfer.getData('text/x-tryon-asset'));
        if (Number.isInteger(idx) && assets[idx]) dropMerge(assets[idx], x, y);
    };

    // ------------------------------------------------------------------
    // Submit final — records the finished look on the canvas into History.
    // The generations already happened per drop; this is the explicit "this
    // one is final" step, so only submitted results are listed.

    const submitFinal = async () => {
        if (!character || busy) return;
        setError(null);
        const items = itemsWorn.join(', ') || 'Final look';
        if (showVideo && video) {
            await recordFinal({ kind: 'video', url: video.url, model: MODELS.find((m) => m.id === videoModel)?.name || videoModel, items: `${items} — animation` });
        } else if (character.kind === 'video') {
            await recordFinal({ kind: 'video', url: character.url, model: MODELS.find((m) => m.id === videoModel)?.name || videoModel, items });
        } else {
            const thumb = await shrinkDataUrl(character.dataUrl).catch(() => null);
            await recordFinal({ kind: 'image', thumb: thumb || character.dataUrl, model: IMAGE_MODELS.find((m) => m.id === imageModel)?.name || imageModel, items });
        }
    };

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
        setItemsWorn([]);
        if (h.kind === 'image') {
            try { replaceCharacter({ kind: 'image', ...parseDataUrl(h.thumb) }); } catch { setError('Could not load that result.'); }
        } else {
            replaceCharacter({ kind: 'video', url: h.url });
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const projectHistory = history.filter((h) => !h.projectId || !projectId || h.projectId === projectId);

    // One width rules the canvas, its action row and its hints: capped by the
    // column AND the viewport height (aspect 3/4 → width = height × 0.75), so
    // canvas + actions stay on screen together instead of scrolling.
    const canvasW = 'w-full max-w-[min(26rem,calc((100vh-15rem)*0.75))]';

    return (
        <>
        {/* Steps left→right: 1 create the character · 2 drop assets on the
            canvas between them · 3 assets + final instruction. Single column
            on mobile in the same order, character first. */}
        <div className="grid gap-5 lg:grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)_minmax(16rem,19rem)] lg:items-start">
            {/* Step 1 — Character */}
            <section className="flex flex-col gap-2.5 rounded-xl border border-line bg-paper-2 p-4 lg:sticky lg:top-6">
                <div className="flex items-center gap-2">
                    <StepDot n={1} />
                    <span className="text-sm font-semibold">Character</span>
                    <div className="ml-auto flex overflow-hidden rounded-md border border-line" role="radiogroup" aria-label="Character media type">
                        {['image', 'video'].map((k) => (
                            <button key={k} type="button" onClick={() => setCharKind(k)} disabled={!!busy}
                                aria-pressed={charKind === k}
                                className={`px-3 py-1 text-[11px] font-semibold capitalize transition-colors ${charKind === k ? 'bg-accent text-accent-ink' : 'bg-paper-3 text-ink-3 hover:text-ink'}`}>
                                {k}
                            </button>
                        ))}
                    </div>
                </div>
                {charKind === 'image'
                    ? <ModelSelect kind="image" value={imageModel} onChange={setImageModel} disabled={!!busy} modelAccess={modelAccess} title="Image model" full />
                    : <ModelSelect kind="video" value={videoModel} onChange={setVideoModel} disabled={!!busy} modelAccess={modelAccess} title="Video model" full />}
                <div className="flex flex-col gap-2"
                    onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); }}
                    onDrop={(e) => { if (e.dataTransfer.files?.length) { e.preventDefault(); addCharRefs(e.dataTransfer.files); } }}>
                    <textarea value={charPrompt} onChange={(e) => setCharPrompt(e.target.value)} rows={3}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generateCharacter(); } }}
                        placeholder={charRefs.length
                            ? 'Describe the look to test on this person — e.g. 1920s police uniform'
                            : charKind === 'image'
                                ? 'Describe a character — or attach an actor’s photo for a look test / casting'
                                : 'e.g. a young man in a plain t-shirt, standing and talking to the camera'}
                        className="w-full resize-none rounded-md border border-line bg-paper-3 px-3 py-2 text-xs leading-relaxed text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent" />
                    <div className="flex gap-2">
                        <input ref={charRefInputRef} type="file" accept="image/*" multiple className="hidden"
                            onChange={(e) => { addCharRefs(e.target.files); e.target.value = ''; }} />
                        <button type="button" onClick={() => charRefInputRef.current?.click()} disabled={!!busy}
                            title="Attach photo(s) — e.g. an actor for a casting or look test; the prompt then styles THAT person"
                            className={`grid h-8 w-9 shrink-0 place-items-center rounded-md border transition-colors ${charRefs.length ? 'border-accent/60 bg-accent/10 text-accent-hi' : 'border-line bg-paper-3 text-ink-3 hover:text-ink'} disabled:opacity-40`}>
                            <ImagePlus size={14} />
                        </button>
                        <MicButton disabled={!!busy}
                            onText={(t) => setCharPrompt((p) => (p ? `${p.replace(/\s+$/, '')} ${t}` : t))}
                            className="grid h-8 w-9 shrink-0 place-items-center rounded-md border border-line bg-paper-3 text-ink-3 transition-colors hover:text-ink disabled:opacity-40" />
                        <button type="button" onClick={generateCharacter} disabled={!!busy || (!charPrompt.trim() && !charRefs.length)}
                            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40">
                            <Sparkles size={13} /> Generate {charKind}
                        </button>
                    </div>
                </div>
                {charRefs.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                        {charRefs.map((r, i) => (
                            <span key={`${r.name}-${i}`} className="group relative">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={r.dataUrl} alt={r.name} title={r.name} className="h-10 w-10 rounded-md border border-line object-cover" />
                                <button type="button" aria-label={`Remove ${r.name}`}
                                    onClick={() => setCharRefs((prev) => prev.filter((_, idx) => idx !== i))}
                                    className="absolute -right-1.5 -top-1.5 hidden rounded-full border border-line bg-paper-1 p-0.5 text-ink-3 hover:text-danger group-hover:block">
                                    <X size={10} />
                                </button>
                            </span>
                        ))}
                        <span className="text-[10px] text-ink-3">This person becomes the character — the prompt styles the look (casting / look test).</span>
                    </div>
                )}
                <input ref={charInputRef} type="file" accept="image/*,video/*" className="hidden"
                    onChange={(e) => { uploadCharacter(e.target.files?.[0]); e.target.value = ''; }} />
                <button type="button" onClick={() => charInputRef.current?.click()} disabled={!!busy}
                    className="inline-flex items-center justify-center gap-1.5 rounded-md border border-line px-3 py-2 text-xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-40">
                    <Upload size={13} /> Or upload a character photo / video
                </button>
            </section>

            {/* Step 2 — the canvas */}
            <section className="flex flex-col items-center gap-3">
                <div
                    ref={canvasRef}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={onDrop}
                    className={`relative flex aspect-[3/4] ${canvasW} items-center justify-center overflow-hidden rounded-xl border bg-paper-2 transition-colors ${dragOver ? 'border-accent ring-2 ring-accent/40' : 'border-line'}`}
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
                            <span className="max-w-xs text-xs leading-relaxed">Create or upload a character on the left, then drag assets from the right onto it — the AI places each one right where you drop it.</span>
                        </div>
                    )}

                    {/* Where the item was dropped — shown while the merge renders */}
                    {!showVideo && overlays.map((o) => (
                        <div key={o.id} style={{ left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: `${o.w * 100}%` }} className="pointer-events-none absolute">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={o.asset.dataUrl} alt={o.asset.name} draggable={false}
                                className="w-full rounded-md border border-dashed border-accent/70 opacity-95 shadow-lg" />
                        </div>
                    ))}

                    {busy && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50 text-white backdrop-blur-[2px]">
                            <Loader2 size={22} className="animate-spin" />
                            <span className="text-xs font-medium">
                                {busy === 'character' ? (charKind === 'video' ? 'Creating the character video… (~1–3 min)' : 'Creating the character…')
                                    : busy === 'merge' ? (character?.kind === 'video' ? 'Placing it across the video… (~2–5 min)' : 'Placing it right there…')
                                        : 'Bringing the character to life… (~1–2 min)'}
                            </span>
                        </div>
                    )}
                    {dragOver && !busy && (
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-accent/20">
                            <span className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-ink">Drop it — the AI places it right here</span>
                        </div>
                    )}
                </div>

                <div className={`flex ${canvasW} flex-wrap items-center gap-2`}>
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
                    {character?.kind === 'image' && (
                        <span className="inline-flex items-center gap-2">
                            <ModelSelect kind="video" value={videoModel} onChange={setVideoModel} disabled={!!busy} modelAccess={modelAccess} title="Model used for the animation" />
                            <button type="button" onClick={animate} disabled={!!busy}
                                className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-2 text-xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-40">
                                <Clapperboard size={14} /> Animate
                            </button>
                        </span>
                    )}
                    {character && (
                        <button type="button" onClick={submitFinal} disabled={!!busy}
                            className="ml-auto inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40">
                            <Wand2 size={14} /> Submit final
                        </button>
                    )}
                </div>

                {character && !busy && (
                    <p className={`${canvasW} text-[11px] leading-relaxed text-ink-3`}>
                        Drop an item anywhere on the character — the AI merges it <strong className="font-semibold text-ink-2">at that exact spot</strong>, properly worn and blended (each drop is one generation). Happy with the look? <strong className="font-semibold text-ink-2">Submit final</strong> saves it to History below.
                    </p>
                )}

                {error && <p className={`${canvasW} text-xs text-danger`}>{error}</p>}
            </section>

            {/* Step 3 — Assets */}
            <aside className="flex flex-col gap-3 rounded-xl border border-line bg-paper-2 p-4 lg:sticky lg:top-6">
                <div className="flex items-center gap-2">
                    <StepDot n={2} />
                    <span className="text-sm font-semibold">Assets</span>
                    <span className="ml-auto text-[11px] text-ink-3">drag onto the character</span>
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
                                <button type="button" title={`${a.name} — drag onto the character where you want it, or click to try it on`}
                                    draggable
                                    onDragStart={(e) => { e.dataTransfer.setData('text/x-tryon-asset', String(i)); e.dataTransfer.effectAllowed = 'copy'; }}
                                    onClick={() => dropMerge(a)}
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
                    Each drop runs the selected model right away and merges the item at the exact spot you dropped it — billed to this project like any studio generation. <strong className="font-semibold text-ink-2">Submit final</strong> costs nothing; it saves the finished look to History.
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
                <ul className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
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

// Small numbered badge that walks the user left→right through the steps.
function StepDot({ n }) {
    return <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent/15 text-[10px] font-bold text-accent-hi">{n}</span>;
}

// Model picker, fed by the same catalogs as the studio (image or video).
// Studio access carries over: a gated model the user already has is plainly
// selectable here; one they lack is disabled (request it in the studio once,
// and it unlocks everywhere — never "exclusively for Try-On").
function ModelSelect({ kind, value, onChange, disabled, title, modelAccess, full = false }) {
    const models = kind === 'image' ? IMAGE_MODELS : MODELS;
    return (
        <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} title={title}
            className={`${full ? 'w-full' : 'max-w-[11rem]'} rounded-md border border-line bg-paper-3 px-2 py-1.5 text-[11px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40`}>
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
