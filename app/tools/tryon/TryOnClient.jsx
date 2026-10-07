'use client';

// Try-On — Lucy-style (lucy.decart.ai) virtual try-on as a studio tool.
// IMAGE ONLY by design: no video characters, no video merges, no animation —
// every generation here is an image (old video finals in History stay viewable).
// 1. Pick the image model (same catalog as the studio), then get a character
//    on the canvas: generate from a prompt, or upload a photo.
// 2. Upload asset images (clothing, props, artwork) into the shelf.
// 3. Drag an asset onto the character and the AI places it RIGHT THERE,
//    immediately: the drop point is baked into a flattened composite the
//    model is told to respect, so a cap dropped on the head sits on the head
//    at that exact spot, blended realistically. Each drop is one generation,
//    billed like any studio generation.
// 4. Submit final records the finished look on the canvas into the History
//    section below — only completed, explicitly submitted results appear.
// Billing/access rides the existing generation pipeline untouched: images go
// through POST /api/generations (gateway quota + budgets).

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, History, ImagePlus, Loader2, Lock, Shirt, Sparkles, Undo2, Upload, Wand2, X } from 'lucide-react';
import ProjectSelect from '../../seedance/ProjectSelect.jsx';
import MicButton from '../../seedance/MicButton.jsx';
import ToolAccessGate, { BudgetChip, useToolStatus } from '../ToolAccessGate.jsx';
import { IMAGE_MODELS, imageRefMax } from '../../../lib/seedance/constants.js';
import { uploadToCdn } from '../../../lib/seedance/upload.js';
import { resolveProjectId, rememberProjectId } from '../../../lib/seedance/projectChoice.mjs';

const DEFAULT_IMAGE_MODEL_ID = 'nano-banana-2'; // open image model

// Drop-merge prompt: Image 1 is the flattened canvas — the character with the
// item pasted as a flat sticker at the exact spot the user dropped it — and
// Image 2 the clean product shot. The user's position is the instruction.
const POSITION_PROMPT = `Virtual try-on. Image 1 shows a character with an item image pasted on top as a flat sticker — the sticker's position and size mark EXACTLY where the user wants that item. Image 2 is the clean product shot of the same item.
Redraw Image 1 as one photorealistic image: the pasted item becomes real at that exact position and scale — clothing/headwear/footwear is worn there, fitted to the body part under the sticker (fabric folds, correct wrap and perspective); an object, prop or artwork sits naturally there in the scene. Blend it with matching lighting and contact shadows, and remove every sticker edge and pasted-on look.
Keep the character's face, identity, hair, pose, body and the background exactly as in Image 1. Change nothing else.`;

// Position-less merge (one item OR several at once): the model places every
// item where it naturally belongs. Used by "Try on selected" and as the
// fallback when the canvas can't be flattened (URL-only character).
const MERGE_PROMPT = `Virtual try-on. Image 1 is the character; every following image is one item to put on them.
Place EVERY item in its correct, natural position for what it is: a cap/hat on the head, shoes on the feet, glasses on the face, a shirt/jacket/dress on the torso, trousers on the legs, a bag held or over the shoulder, artwork hung on the wall. Resize and fit each one to the character's pose and perspective, with realistic fabric folds, contact shadows and matching lighting — all items worn together in one coherent outfit.
Keep the character's face, identity, hair, pose, body and the background from Image 1 exactly unchanged — change ONLY what the items add. Output a single photorealistic image with no pasted-on look.`;

// Appended when the canvas character came from the project's LOCKED cast: the
// original is sent as the last reference so the approved face survives any
// number of merges by any team member.
const ANCHOR_NOTE = 'IDENTITY LOCK: the LAST reference image is this character\'s approved, locked identity — the output\'s face, skin tone, hair and build must match it EXACTLY.';

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
    // Workspace workflows (named styles). The gateway already inherits the
    // user's studio attachment on every Try-On generation — this makes that
    // visible and controllable here: keep the attachment, pick another
    // workflow for this tool, or switch styling off entirely.
    const [workflows, setWorkflows] = useState([]);
    const [wfAccess, setWfAccess] = useState('none');
    const { status, error: statusError, refresh } = useToolStatus('tryon', projectId);

    useEffect(() => {
        let alive = true;
        fetch('/api/workflows')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                if (!alive || !d) return;
                setWorkflows(Array.isArray(d.items) ? d.items : []);
                setWfAccess(d.access ?? 'none');
            })
            .catch(() => { /* picker just stays hidden */ });
        return () => { alive = false; };
    }, []);

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
                            <TryOnWorkspace projectId={projectId} modelAccess={modelAccess} workflows={workflows} wfAccess={wfAccess} />
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

// Submit one image generation and poll it to a displayable image.
// Returns { mimeType, b64, dataUrl } (inline whenever the provider allows).
async function runImageJob({ projectId, modelId, prompt, refs = [], styleOptions = {} }) {
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
            // styleOptions: workflow routing — styleWorkflowId to pin one, or
            // styleLook 'none' to opt this generation out of styling.
            options: { imageCount: 1, aspectRatio: '3:4', imageSize, mode: 'tryon', ...styleOptions },
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
// Project stores — wardrobe, locked cast and finals live on the server, scoped
// and shared per project (/api/tryon/*). Media objects sit in the studio's own
// bucket; rows carry only the key.

export async function storeFetch(path, init) {
    const r = await fetch(path, init);
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(d?.error || `Request failed (${r.status}).`);
    return d;
}

// Same-origin byte proxy for a stored object — usable as an <img>/<video> src
// (History keeps playing finals submitted back when Try-On still made videos)
// AND fetchable for inline bytes without depending on the bucket's CORS.
export const fileSrc = (key) => `/api/tryon/file?key=${encodeURIComponent(key)}`;

// Stored object → { mimeType, b64, dataUrl } for inline delivery to models.
async function inlineFromKey(key) {
    const blob = await (await fetch(fileSrc(key))).blob();
    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read the stored image.'));
        reader.readAsDataURL(blob);
    });
    return parseDataUrl(dataUrl);
}

// data: URL → File, for uploading canvas results to the bucket.
function dataUrlToFile(dataUrl, name) {
    const { mimeType, b64 } = parseDataUrl(dataUrl);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new File([bytes], name, { type: mimeType });
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

export function TryOnWorkspace({ projectId, modelAccess, workflows, wfAccess, onCastChange }) {
    // character: { kind:'image', mimeType, b64, dataUrl }
    const [character, setCharacter] = useState(null);
    const [versions, setVersions] = useState([]); // older character states, newest first
    const [assets, setAssets] = useState([]); // { id, name, mimeType, b64, dataUrl, aspect }
    // Shelf multi-select: tick several assets and try them all on in ONE
    // generation ("Try on selected") — each placed where it belongs.
    const [selectedIds, setSelectedIds] = useState(() => new Set());
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
    const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL_ID);
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(null); // 'character' | 'merge' | 'final'
    const [error, setError] = useState(null);
    const [dragOver, setDragOver] = useState(false);
    const [history, setHistory] = useState([]); // the project's submitted finals (server rows)
    // The project's locked cast: canonical characters the whole team dresses.
    const [cast, setCast] = useState([]);
    // When the canvas character came from the locked cast, its ORIGINAL image
    // anchors identity on every merge — the approved face never drifts.
    const [castAnchor, setCastAnchor] = useState(null); // { name, mimeType, b64 }
    const [lockName, setLockName] = useState(null); // non-null = the lock name form is open
    // Workflow choice for every generation this tool fires:
    // 'auto' = whatever the user attached in the studio (the gateway inherits
    // it anyway — this is the default and today's behaviour), 'none' = styling
    // off for Try-On, or a workflow id to pin one explicitly.
    const [wfChoice, setWfChoice] = useState('auto');
    const charInputRef = useRef(null);
    const charRefInputRef = useRef(null);
    const assetInputRef = useRef(null);
    const canvasRef = useRef(null);

    // Project switch = clean room: the canvas empties and the wardrobe, cast
    // and finals reload for the newly selected project.
    useEffect(() => {
        setCharacter(null);
        setVersions([]);
        setOverlays([]);
        setItemsWorn([]);
        setSelectedIds(new Set());
        setCastAnchor(null);
        setLockName(null);
        setError(null);
        setAssets([]);
        setCast([]);
        setHistory([]);
        if (!projectId) return undefined;
        let alive = true;
        Promise.all([
            storeFetch(`/api/tryon/assets?projectId=${projectId}`),
            storeFetch(`/api/tryon/characters?projectId=${projectId}`),
            storeFetch(`/api/tryon/finals?projectId=${projectId}`),
        ]).then(([a, c, f]) => {
            if (!alive) return;
            setAssets((a.items || []).map((r) => ({ id: r.id, name: r.name, mediaKey: r.media_key, createdBy: r.created_by })));
            setCast(c.items || []);
            setHistory(f.items || []);
        }).catch((e) => { if (alive) setError(e.message); });
        return () => { alive = false; };
    }, [projectId]);

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
    }, [modelAccess, imageModel]);

    const replaceCharacter = (next) => {
        setVersions((v) => (character ? [character, ...v].slice(0, 8) : v));
        setCharacter(next);
        setOverlays([]);
    };

    const recordFinal = async ({ kind, mediaKey, items, model }) => {
        const d = await storeFetch('/api/tryon/finals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, kind, mediaKey, items, model }),
        });
        setHistory((prev) => [d.item, ...prev]);
    };

    const deleteHistory = async (id) => {
        try {
            await storeFetch(`/api/tryon/finals?id=${id}&projectId=${projectId}`, { method: 'DELETE' });
            setHistory((prev) => prev.filter((h) => h.id !== id));
        } catch (e) { setError(e.message); }
    };

    // The workflow choice in the image pipeline's dialect: styleWorkflowId to
    // pin one, styleLook 'none' to opt out. 'auto' sends nothing — the gateway
    // then applies the user's studio attachment (or the project style).
    const wfImageStyle = () => (wfChoice === 'none' ? { styleLook: 'none' }
        : wfChoice === 'auto' ? {} : { styleWorkflowId: Number(wfChoice) });

    const generateCharacter = () => run('character', async () => {
        const p = charPrompt.trim();
        if (!p && !charRefs.length) throw new Error('Describe the character image you want to create — or attach a photo.');
        setItemsWorn([]); // a fresh character wears nothing yet
        setCastAnchor(null); // a new identity — no longer the locked cast member
        // With reference photos attached (casting / look test), the person in
        // them IS the character — identity locked, the prompt styles the look.
        const prompt = charRefs.length
            ? `Full-body photorealistic shot of the person from the reference photo(s) — keep their face, identity, skin tone, hair and build EXACTLY as in the references. Standing, facing the camera, clean simple background, soft studio lighting. ${p || 'Natural, neutral styling.'}`
            : `Full-body photorealistic shot of a character, standing, facing the camera, clean simple background, soft studio lighting. ${p}`;
        const img = await runImageJob({ projectId, modelId: imageModel, prompt, refs: charRefs, styleOptions: wfImageStyle() });
        replaceCharacter({ kind: 'image', ...img });
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
        setCastAnchor(null); // a new identity — no longer the locked cast member
        if (!file?.type?.startsWith('image/')) throw new Error('Pick an image file — Try-On is image only.');
        const img = await fileToInline(file);
        replaceCharacter({ kind: 'image', ...img });
    });

    // Upload into the PROJECT wardrobe: bytes to the bucket, a row to the
    // store — the whole team sees it, on any device, from now on. The inline
    // b64 is kept locally so an immediate merge needs no round trip.
    const addAssets = async (files) => {
        setError(null);
        const added = [];
        for (const file of Array.from(files || []).filter((f) => f.type?.startsWith('image/'))) {
            try {
                const img = await fileToInline(file);
                const { key } = await uploadToCdn(file);
                const d = await storeFetch('/api/tryon/assets', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ projectId, name: file.name, mediaKey: key }),
                });
                const a = { id: d.item.id, name: d.item.name, mediaKey: key, createdBy: d.item.created_by, ...img };
                added.push(a);
                setAssets((prev) => [a, ...prev]);
            } catch (e) { setError(e.message); }
        }
        return added;
    };

    const removeAsset = async (id) => {
        try {
            await storeFetch(`/api/tryon/assets?id=${id}&projectId=${projectId}`, { method: 'DELETE' });
            setAssets((prev) => prev.filter((a) => a.id !== id));
            setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
        } catch (e) { setError(e.message); }
    };

    // A wardrobe row loaded from the server has no bytes yet — pull them once
    // through the proxy and cache on the entry.
    const ensureInline = async (asset) => {
        if (asset.b64) return asset;
        const inline = await inlineFromKey(asset.mediaKey);
        const full = { ...asset, ...inline };
        setAssets((prev) => prev.map((a) => (a.id === asset.id ? full : a)));
        return full;
    };

    const toggleSelect = (id) => {
        setError(null);
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    // ------------------------------------------------------------------
    // Drop = generate. The item is merged AT THE DROP POINT, immediately —
    // the drop position is flattened into the composite the model receives.

    const canvasPoint = (e) => {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return { x: 0.5, y: 0.35 };
        return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
    };

    const dropMerge = (rawAsset, x = 0.5, y = 0.35) => run('merge', async () => {
        if (!character) throw new Error('Add a character first, then drop items on it.');
        const asset = await ensureInline(rawAsset);
        const w = 0.35; // sticker width as a fraction of the canvas
        const overlay = { id: `ov-${Date.now().toString(36)}`, asset, x: clamp(x - w / 2, 0, 1 - w), y: clamp(y - 0.08, 0, 0.9), w };
        setOverlays([overlay]); // visible under the busy veil while it renders
        const extra = note.trim();
        try {
            // Composite with the sticker at the drop point (the position
            // instruction), plus the clean product shot. Falls back to
            // position-less refs on a tainted canvas.
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
            // A locked cast character anchors identity on every merge.
            if (castAnchor) { refs.push(castAnchor); prompt += `\n${ANCHOR_NOTE}`; }
            const img = await runImageJob({ projectId, modelId: imageModel, prompt, refs, styleOptions: wfImageStyle() });
            replaceCharacter({ kind: 'image', ...img });
            setItemsWorn((prev) => [...prev, asset.name]);
        } finally {
            setOverlays([]);
        }
    });

    // Try on every selected asset in ONE generation — the model dresses the
    // character with the whole set, each item in its natural place.
    const mergeSelected = () => run('merge', async () => {
        if (!character) throw new Error('Add a character first.');
        const picked = await Promise.all(assets.filter((a) => selectedIds.has(a.id)).map(ensureInline));
        if (!picked.length) throw new Error('Select at least one asset first.');
        const extra = note.trim();
        // The character ref takes one slot of the model's reference cap —
        // and the cast identity anchor, when present, takes another.
        const cap = imageRefMax(imageModel) - 1 - (castAnchor ? 1 : 0);
        if (picked.length > cap) {
            throw new Error(`${IMAGE_MODELS.find((m) => m.id === imageModel)?.name || 'This model'} takes up to ${cap} items at once here — unselect some, or switch to a model with a higher reference limit.`);
        }
        const base = character.b64 ? character : await urlToInline(character.dataUrl)
            .catch(() => { throw new Error('This image can’t be reused directly — download it and upload it as the character.'); });
        let prompt = extra ? `${MERGE_PROMPT}\nAdditional instruction: ${extra}` : MERGE_PROMPT;
        const refs = [base, ...picked];
        if (castAnchor) { refs.push(castAnchor); prompt += `\n${ANCHOR_NOTE}`; }
        const img = await runImageJob({ projectId, modelId: imageModel, prompt, refs, styleOptions: wfImageStyle() });
        replaceCharacter({ kind: 'image', ...img });
        setItemsWorn((prev) => [...prev, ...picked.map((a) => a.name)]);
        setSelectedIds(new Set());
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

    const submitFinal = () => run('final', async () => {
        if (!character) throw new Error('Add a character first.');
        const items = itemsWorn.join(', ') || 'Final look';
        const { key } = await uploadToCdn(dataUrlToFile(character.dataUrl, 'tryon-final.jpg'));
        await recordFinal({ kind: 'image', mediaKey: key, model: IMAGE_MODELS.find((m) => m.id === imageModel)?.name || imageModel, items });
    });

    // Lock the canvas character into the project cast under a name — from
    // then on it is the project's shared, protected reference character.
    const lockCharacter = () => run('final', async () => {
        const name = (lockName || '').trim();
        if (!character) throw new Error('Add a character first.');
        if (!name) throw new Error('Give the character a name to lock it.');
        const { key } = await uploadToCdn(dataUrlToFile(character.dataUrl, `${name.replace(/[^\w.-]+/g, '_')}.jpg`));
        const d = await storeFetch('/api/tryon/characters', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, name, mediaKey: key, kind: character.kind }),
        });
        setCast((prev) => [d.item, ...prev]);
        onCastChange?.();
        setLockName(null);
        // Locking also arms the identity anchor for this session.
        if (character.kind === 'image' && character.b64) {
            setCastAnchor({ name, mimeType: character.mimeType, b64: character.b64 });
        }
    });

    // Put a locked cast member on the canvas and arm the identity anchor so
    // every merge keeps the approved face.
    const pickCastMember = (m) => run('character', async () => {
        setItemsWorn([]);
        const inline = await inlineFromKey(m.media_key);
        replaceCharacter({ kind: 'image', ...inline });
        setCastAnchor({ name: m.name, mimeType: inline.mimeType, b64: inline.b64 });
    });

    const deleteCastMember = async (id) => {
        try {
            await storeFetch(`/api/tryon/characters?id=${id}&projectId=${projectId}`, { method: 'DELETE' });
            setCast((prev) => prev.filter((m) => m.id !== id));
            onCastChange?.();
        } catch (e) { setError(e.message); }
    };

    const undo = () => {
        if (!versions.length || busy) return;
        setCharacter(versions[0]);
        setVersions((v) => v.slice(1));
        setOverlays([]);
    };

    const reuseFromHistory = (h) => run('character', async () => {
        setItemsWorn([]);
        setCastAnchor(null);
        const inline = await inlineFromKey(h.media_key);
        replaceCharacter({ kind: 'image', ...inline });
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });

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
                </div>
                {cast.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-2"><Lock size={10} /> Project cast <span className="font-normal text-ink-3">— shared, identity-locked</span></span>
                        <ul className="flex gap-2 overflow-x-auto pb-1">
                            {/* Image members only — Try-On no longer dresses video characters. */}
                            {cast.filter((m) => m.kind !== 'video').map((m) => (
                                <li key={m.id} className="group relative shrink-0">
                                    <button type="button" onClick={() => pickCastMember(m)} disabled={!!busy}
                                        title={`${m.name} — locked by ${m.creator_name || 'a teammate'}; click to dress this character`}
                                        className="flex w-16 flex-col items-center gap-1 disabled:opacity-40">
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img src={fileSrc(m.media_key)} alt={m.name} className="h-16 w-16 rounded-lg border border-line object-cover transition-colors group-hover:border-accent/60" />
                                        <span className="w-16 truncate text-center text-[10px] text-ink-2">{m.name}</span>
                                    </button>
                                    <button type="button" aria-label={`Remove ${m.name}`}
                                        onClick={() => deleteCastMember(m.id)}
                                        className="absolute -right-1 -top-1 hidden rounded-full border border-line bg-paper-1 p-0.5 text-ink-3 hover:text-danger group-hover:block">
                                        <X size={10} />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                <ModelSelect value={imageModel} onChange={setImageModel} disabled={!!busy} modelAccess={modelAccess} title="Image model" full />
                {wfAccess === 'approved' && workflows.length > 0 && (
                    <select value={wfChoice} onChange={(e) => setWfChoice(e.target.value)} disabled={!!busy}
                        title="Workspace workflow (named style) applied to every generation in this tool — characters and try-ons. Auto follows your studio attachment; None switches styling off for Try-On."
                        className="w-full rounded-md border border-line bg-paper-3 px-2 py-1.5 text-[11px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40">
                        <option value="auto">Workflow: studio attachment (auto)</option>
                        <option value="none">Workflow: none for Try-On</option>
                        {workflows.map((w) => (
                            <option key={w.id} value={String(w.id)}>
                                Workflow: {w.name}{w.media && w.media !== 'all' ? ` (${w.media} only)` : ''}
                            </option>
                        ))}
                    </select>
                )}
                <div className="flex flex-col gap-2"
                    onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); }}
                    onDrop={(e) => { if (e.dataTransfer.files?.length) { e.preventDefault(); addCharRefs(e.dataTransfer.files); } }}>
                    <textarea value={charPrompt} onChange={(e) => setCharPrompt(e.target.value)} rows={3}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generateCharacter(); } }}
                        placeholder={charRefs.length
                            ? 'Describe the look to test on this person — e.g. 1920s police uniform'
                            : 'Describe a character — or attach an actor’s photo for a look test / casting'}
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
                            <Sparkles size={13} /> Generate image
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
                <input ref={charInputRef} type="file" accept="image/*" className="hidden"
                    onChange={(e) => { uploadCharacter(e.target.files?.[0]); e.target.value = ''; }} />
                <button type="button" onClick={() => charInputRef.current?.click()} disabled={!!busy}
                    className="inline-flex items-center justify-center gap-1.5 rounded-md border border-line px-3 py-2 text-xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-40">
                    <Upload size={13} /> Or upload a character photo
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
                    {character ? (
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
                    {overlays.map((o) => (
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
                                {busy === 'character' ? 'Loading the character…'
                                    : busy === 'merge' ? 'Placing it right there…'
                                        : 'Saving to the project…'}
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
                    {versions.length > 0 && (
                        <button type="button" onClick={undo} disabled={!!busy}
                            className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-40">
                            <Undo2 size={13} /> Undo
                        </button>
                    )}
                    {character && (
                        <span className="ml-auto inline-flex items-center gap-2">
                            <button type="button" onClick={() => setLockName((v) => (v == null ? '' : null))} disabled={!!busy}
                                title="Lock this character into the project cast — the whole team can then dress this exact character, and its face stays protected"
                                className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-2 text-xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-40">
                                <Lock size={13} /> Lock
                            </button>
                            <button type="button" onClick={submitFinal} disabled={!!busy}
                                className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40">
                                <Wand2 size={14} /> Submit final
                            </button>
                        </span>
                    )}
                </div>

                {lockName != null && (
                    <div className={`flex ${canvasW} items-center gap-2`}>
                        <input autoFocus value={lockName} onChange={(e) => setLockName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') lockCharacter(); if (e.key === 'Escape') setLockName(null); }}
                            placeholder="Name this character — e.g. Inspector Rahul"
                            className="min-w-0 flex-1 rounded-md border border-line bg-paper-3 px-3 py-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent" />
                        <button type="button" onClick={lockCharacter} disabled={!!busy || !lockName.trim()}
                            className="rounded-md bg-accent px-3 py-2 text-xs font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40">
                            Lock to project
                        </button>
                    </div>
                )}

                {castAnchor && !busy && (
                    <p className={`${canvasW} text-[11px] text-accent-hi`}>
                        <Lock size={10} className="mr-1 inline" /> Identity locked to “{castAnchor.name}” — every try-on keeps this exact face.
                    </p>
                )}

                {character && !busy && (
                    <p className={`${canvasW} text-[11px] leading-relaxed text-ink-3`}>
                        Drop an item anywhere on the character — the AI merges it <strong className="font-semibold text-ink-2">at that exact spot</strong>, properly worn and blended (each drop is one generation). Happy with the look? <strong className="font-semibold text-ink-2">Submit final</strong> saves it to the project’s History below; <strong className="font-semibold text-ink-2">Lock</strong> makes this character the project’s shared reference.
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
                    <>
                    <ul className="grid grid-cols-3 gap-2">
                        {assets.map((a, i) => {
                            const picked = selectedIds.has(a.id);
                            return (
                                <li key={a.id} className="group relative">
                                    <button type="button" title={`${a.name} — click to select, or drag onto the character where you want it`}
                                        draggable
                                        aria-pressed={picked}
                                        onDragStart={(e) => { e.dataTransfer.setData('text/x-tryon-asset', String(i)); e.dataTransfer.effectAllowed = 'copy'; }}
                                        onClick={() => toggleSelect(a.id)}
                                        disabled={!!busy}
                                        className={`block w-full cursor-grab overflow-hidden rounded-lg border transition-colors active:cursor-grabbing disabled:cursor-default disabled:opacity-60 ${picked ? 'border-accent ring-2 ring-accent/50' : 'border-line hover:border-accent/60'}`}>
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img src={a.dataUrl || fileSrc(a.mediaKey)} alt={a.name} className="aspect-square w-full object-cover" />
                                    </button>
                                    {picked && (
                                        <span className="pointer-events-none absolute left-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-accent p-0.5 text-accent-ink">
                                            <Check size={11} strokeWidth={3} />
                                        </span>
                                    )}
                                    <button type="button" aria-label={`Remove ${a.name}`}
                                        onClick={() => removeAsset(a.id)}
                                        className="absolute -right-1.5 -top-1.5 hidden rounded-full border border-line bg-paper-1 p-0.5 text-ink-3 hover:text-danger group-hover:block">
                                        <X size={11} />
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                    {selectedIds.size > 0 && (
                        <div className="flex items-center gap-2">
                            <button type="button" onClick={mergeSelected} disabled={!!busy || !character}
                                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40">
                                <Sparkles size={13} /> Try on {selectedIds.size} selected
                            </button>
                            <button type="button" onClick={() => setSelectedIds(new Set())} disabled={!!busy}
                                className="rounded-md border border-line px-3 py-2 text-xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-40">
                                Clear
                            </button>
                        </div>
                    )}
                    </>
                )}
                <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-semibold text-ink-2">Final instruction <span className="font-normal text-ink-3">(optional)</span></span>
                    <input value={note} onChange={(e) => setNote(e.target.value)}
                        placeholder="e.g. wear it open, over the t-shirt"
                        className="rounded-md border border-line bg-paper-3 px-3 py-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent" />
                </label>
                <p className="text-[11px] leading-relaxed text-ink-3">
                    Drag one item for exact placement, or click to select several and <strong className="font-semibold text-ink-2">Try on selected</strong> — the whole set goes on in one generation, each piece where it belongs. Every generation bills this project like any studio one. <strong className="font-semibold text-ink-2">Submit final</strong> costs nothing; it saves the finished look to History.
                </p>
            </aside>
        </div>

        {/* History — completed final submissions only */}
        <section className="mt-10">
            <div className="mb-3 flex items-center gap-2">
                <History size={15} className="text-accent-hi" />
                <h2 className="text-sm font-semibold">History — final submissions</h2>
                <span className="text-[11px] text-ink-3">only completed results are listed · shared with this project</span>
            </div>
            {!history.length ? (
                <p className="rounded-xl border border-line bg-paper-2 p-5 text-xs text-ink-3">
                    Nothing here yet. Place an item on a character and press <strong className="font-semibold text-ink-2">Submit final</strong> — the finished result shows up here for the whole project.
                </p>
            ) : (
                <ul className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                    {history.map((h) => (
                        <li key={h.id} className="flex flex-col overflow-hidden rounded-xl border border-line bg-paper-2">
                            {h.kind === 'image'
                                // eslint-disable-next-line @next/next/no-img-element
                                ? <img src={fileSrc(h.media_key)} alt={h.items || 'Final result'} className="aspect-[3/4] w-full object-cover" />
                                : <video src={fileSrc(h.media_key)} controls preload="metadata" playsInline className="aspect-[3/4] w-full bg-black object-contain" />}
                            <div className="flex flex-col gap-1.5 p-3">
                                <span className="truncate text-xs font-medium text-ink-2" title={h.items}>{h.items || 'Final look'}</span>
                                <span className="text-[11px] text-ink-3">
                                    {[h.model, h.creator_name, new Date(h.created_at).toLocaleDateString()].filter(Boolean).join(' · ')}
                                </span>
                                <div className="mt-1 flex gap-2">
                                    {/* Old video finals stay viewable but can't be dressed — image only. */}
                                    {h.kind === 'image' && (
                                        <button type="button" onClick={() => reuseFromHistory(h)} disabled={!!busy}
                                            className="rounded-md border border-line px-2.5 py-1 text-[11px] font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-40">
                                            Use as character
                                        </button>
                                    )}
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

// Image-model picker, fed by the same catalog as the studio.
// Studio access carries over: a gated model the user already has is plainly
// selectable here; one they lack is disabled (request it in the studio once,
// and it unlocks everywhere — never "exclusively for Try-On").
function ModelSelect({ value, onChange, disabled, title, modelAccess, full = false }) {
    return (
        <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} title={title}
            className={`${full ? 'w-full' : 'max-w-[11rem]'} rounded-md border border-line bg-paper-3 px-2 py-1.5 text-[11px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40`}>
            {IMAGE_MODELS.map((m) => {
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
