'use client';

// Try-On — Lucy-style (lucy.decart.ai) virtual try-on as a studio tool.
// 1. Get a character on the canvas (generate from a prompt, or upload).
// 2. Upload asset images (clothing, props, artwork) into the shelf.
// 3. Drag an asset onto the character → Nano Banana merges them (the
//    character "wears" the asset). Each merge becomes the new canvas image,
//    with one-step undo back through earlier versions.
// 4. Animate → Seedance (first-frame) brings the dressed character to life.
// Billing/access rides the existing generation pipelines untouched: images go
// through POST /api/generations (gateway quota + budgets), video through the
// ModelArk proxy — both on the open-by-default models.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Clapperboard, ImagePlus, Loader2, Shirt, Sparkles, Undo2, Upload, X } from 'lucide-react';
import ProjectSelect from '../../seedance/ProjectSelect.jsx';
import { MODELS } from '../../../lib/seedance/constants.js';
import { buildPayload, createTask, pollTask } from '../../../lib/seedance/client.js';
import { resolveProjectId, rememberProjectId } from '../../../lib/seedance/projectChoice.mjs';

const IMAGE_MODEL_ID = 'nano-banana-2'; // open image model, no access request needed
const VIDEO_MODEL_ID = MODELS.find((m) => m.kind === 'mini').id; // open video tier

const MERGE_PROMPT = `Virtual try-on. Image 1 is the character, Image 2 is the item.
Put the item from Image 2 onto the character in Image 1: if it is clothing, the character now wears it, fitted naturally with realistic fabric folds, lighting and shadows; if it is an object, prop or artwork, place it naturally with the character (held, worn, or set into the scene).
Keep the character's face, identity, hair, pose, body and the background from Image 1 exactly unchanged — change ONLY what the item adds. Output a single photorealistic image.`;

const ANIMATE_PROMPT = 'The character comes to life: stands up (if seated) and moves naturally and confidently — subtle realistic body motion, the clothing moves with them. Keep the identity, outfit, lighting and background exactly as the image. Smooth, stable camera.';

export default function TryOnClient() {
    const [projects, setProjects] = useState([]);
    const [projectId, setProjectId] = useState(null);
    const [projectsError, setProjectsError] = useState(null);

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
                        {projects.length > 0 && <ProjectSelect projects={projects} value={projectId} onChange={pickProject} />}
                    </div>
                </header>
                {projectsError
                    ? <div className="text-xs text-danger">{projectsError}</div>
                    : <TryOnWorkspace projectId={projectId} />}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Image helpers

// Downscale to ~1024px JPEG for inline delivery (same budget as the studio's
// reference images — two inline refs stay well under the request body cap).
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
    return parseDataUrl(dataUrl);
}

function parseDataUrl(dataUrl) {
    const m = /^data:(.*?);base64,(.*)$/.exec(dataUrl);
    if (!m) throw new Error('Could not encode the image.');
    return { mimeType: m[1], b64: m[2], dataUrl };
}

// Character images coming back from the gateway may be a URL instead of
// inline bytes — pull them local so the next merge can send them inline.
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

// Submit one image generation and poll it to a displayable image.
// Returns { mimeType, b64, dataUrl } (inline whenever the provider allows).
async function runImageJob({ projectId, prompt, refs = [] }) {
    const request = refs.length
        ? { prompt, parts: [{ text: prompt }, ...refs.map((r) => ({ inlineData: { mimeType: r.mimeType, data: r.b64 } }))] }
        : { prompt };
    const res = await fetch('/api/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            projectId, modelId: IMAGE_MODEL_ID, request,
            options: { imageCount: 1, aspectRatio: '3:4', imageSize: '1K' },
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
            // the image still displays but can't feed the next merge inline.
            try { return await urlToInline(url); } catch { return { mimeType: null, b64: null, dataUrl: url }; }
        }
        if (['failed', 'cancelled', 'timed_out'].includes(d.status)) {
            throw new Error(d.error?.message || 'The image generation failed.');
        }
    }
    throw new Error('Timed out waiting for the image.');
}

// ---------------------------------------------------------------------------
// Workspace

function TryOnWorkspace({ projectId }) {
    const [character, setCharacter] = useState(null); // { mimeType, b64, dataUrl }
    const [versions, setVersions] = useState([]); // older character states, newest first
    const [assets, setAssets] = useState([]); // { name, mimeType, b64, dataUrl }
    const [charPrompt, setCharPrompt] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(null); // 'character' | 'merge' | 'animate'
    const [error, setError] = useState(null);
    const [dragOver, setDragOver] = useState(false);
    const [video, setVideo] = useState(null); // { url }
    const [showVideo, setShowVideo] = useState(false);
    const charInputRef = useRef(null);
    const assetInputRef = useRef(null);

    const run = async (kind, fn) => {
        if (busy) return;
        setBusy(kind);
        setError(null);
        try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(null); }
    };

    const generateCharacter = () => run('character', async () => {
        const p = charPrompt.trim();
        if (!p) throw new Error('Describe the character you want to create.');
        const prompt = `Full-body photorealistic character portrait, standing, facing the camera, clean simple background, soft studio lighting. ${p}`;
        const img = await runImageJob({ projectId, prompt });
        setVersions((v) => (character ? [character, ...v].slice(0, 8) : v));
        setCharacter(img);
        setVideo(null);
        setShowVideo(false);
    });

    const uploadCharacter = (file) => run('character', async () => {
        if (!file?.type?.startsWith('image/')) throw new Error('Pick an image file.');
        const img = await fileToInline(file);
        setVersions((v) => (character ? [character, ...v].slice(0, 8) : v));
        setCharacter(img);
        setVideo(null);
        setShowVideo(false);
    });

    const addAssets = async (files) => {
        setError(null);
        for (const file of Array.from(files || []).filter((f) => f.type?.startsWith('image/'))) {
            try {
                const img = await fileToInline(file);
                setAssets((prev) => [...prev, { name: file.name, ...img }]);
            } catch { /* unreadable image — skip */ }
        }
    };

    const merge = (asset) => run('merge', () => mergeNow(asset));

    const animate = () => run('animate', async () => {
        if (!character) throw new Error('Add a character first.');
        const payload = buildPayload({
            options: { model: VIDEO_MODEL_ID, ratio: 'adaptive', resolution: '720p', duration: 5, generate_audio: false, watermark: false, seed: -1 },
            prompt: ANIMATE_PROMPT,
            mediaItems: [{ kind: 'image', url: character.dataUrl, role: 'first_frame' }],
        });
        const { id } = await createTask(payload, 'i2v_first', projectId);
        const { url } = await pollTask(id);
        setVideo({ url });
        setShowVideo(true);
    });

    const undo = () => {
        if (!versions.length || busy) return;
        setCharacter(versions[0]);
        setVersions((v) => v.slice(1));
        setVideo(null);
        setShowVideo(false);
    };

    const onDrop = (e) => {
        e.preventDefault();
        setDragOver(false);
        if (busy) return;
        if (e.dataTransfer.files?.length) {
            // An image dragged straight from the OS: if there's no character yet
            // it becomes the character, otherwise it's an asset tried on at once.
            const file = e.dataTransfer.files[0];
            if (!character) { uploadCharacter(file); return; }
            run('merge', async () => {
                if (!file?.type?.startsWith('image/')) throw new Error('Drop an image file.');
                const img = await fileToInline(file);
                setAssets((prev) => [...prev, { name: file.name, ...img }]);
                await mergeNow(img);
            });
            return;
        }
        const idx = Number(e.dataTransfer.getData('text/x-tryon-asset'));
        if (Number.isInteger(idx) && assets[idx]) merge(assets[idx]);
    };

    // merge() wraps run(); this is the bare body for callers already inside run().
    const mergeNow = async (asset) => {
        if (!character) throw new Error('Add a character first.');
        // Re-inline a URL-only character (e.g. a merge that came back as a link).
        const base = character.b64 ? character : await urlToInline(character.dataUrl)
            .catch(() => { throw new Error('This image can’t be reused directly — download it and upload it as the character.'); });
        const extra = note.trim();
        const prompt = extra ? `${MERGE_PROMPT}\nAdditional instruction: ${extra}` : MERGE_PROMPT;
        const img = await runImageJob({ projectId, prompt, refs: [base, asset] });
        setVersions((v) => [character, ...v].slice(0, 8));
        setCharacter(img);
        setVideo(null);
        setShowVideo(false);
    };

    return (
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem] lg:items-start">
            {/* Character canvas */}
            <section className="flex flex-col gap-3">
                <div
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={onDrop}
                    className={`relative mx-auto flex aspect-[3/4] w-full max-w-md items-center justify-center overflow-hidden rounded-xl border bg-paper-2 transition-colors ${dragOver ? 'border-accent ring-2 ring-accent/40' : 'border-line'}`}
                >
                    {showVideo && video ? (
                        <video src={video.url} controls autoPlay loop playsInline className="h-full w-full object-contain bg-black" />
                    ) : character ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={character.dataUrl} alt="Character" className="h-full w-full object-cover" />
                    ) : (
                        <div className="flex flex-col items-center gap-2 p-6 text-center text-ink-3">
                            <Shirt size={26} />
                            <span className="text-sm font-medium text-ink-2">No character yet</span>
                            <span className="max-w-xs text-xs leading-relaxed">Generate one below, upload a photo, or drop an image here. Then drag assets from the shelf onto it.</span>
                        </div>
                    )}
                    {busy && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50 text-white backdrop-blur-[2px]">
                            <Loader2 size={22} className="animate-spin" />
                            <span className="text-xs font-medium">
                                {busy === 'character' ? 'Creating the character…' : busy === 'merge' ? 'Trying it on…' : 'Bringing the character to life… (~1–2 min)'}
                            </span>
                        </div>
                    )}
                    {dragOver && !busy && (
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-accent/20">
                            <span className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-ink">Drop to try it on</span>
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
                            <Undo2 size={13} /> Undo try-on
                        </button>
                    )}
                    {character && (
                        <button type="button" onClick={animate} disabled={!!busy}
                            className="ml-auto inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40">
                            <Clapperboard size={14} /> Animate (5s video)
                        </button>
                    )}
                </div>

                {error && <p className="mx-auto w-full max-w-md text-xs text-danger">{error}</p>}

                {/* Character sources */}
                <div className="mx-auto flex w-full max-w-md flex-col gap-2 rounded-xl border border-line bg-paper-2 p-3">
                    <span className="text-xs font-semibold text-ink-2">Character</span>
                    <div className="flex gap-2">
                        <input value={charPrompt} onChange={(e) => setCharPrompt(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') generateCharacter(); }}
                            placeholder="e.g. a young woman with short black hair, jeans and a white t-shirt"
                            className="min-w-0 flex-1 rounded-md border border-line bg-paper-3 px-3 py-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent" />
                        <button type="button" onClick={generateCharacter} disabled={!!busy || !charPrompt.trim()}
                            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40">
                            <Sparkles size={13} /> Generate
                        </button>
                    </div>
                    <input ref={charInputRef} type="file" accept="image/*" className="hidden"
                        onChange={(e) => { uploadCharacter(e.target.files?.[0]); e.target.value = ''; }} />
                    <button type="button" onClick={() => charInputRef.current?.click()} disabled={!!busy}
                        className="inline-flex items-center justify-center gap-1.5 rounded-md border border-line px-3 py-2 text-xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-40">
                        <Upload size={13} /> Or upload a character photo
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
                                <button type="button" title={`${a.name} — drag onto the character, or click to try on`}
                                    draggable
                                    onDragStart={(e) => { e.dataTransfer.setData('text/x-tryon-asset', String(i)); e.dataTransfer.effectAllowed = 'copy'; }}
                                    onClick={() => merge(a)}
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
                    <span className="text-xs font-semibold text-ink-2">Try-on instruction <span className="font-normal text-ink-3">(optional)</span></span>
                    <input value={note} onChange={(e) => setNote(e.target.value)}
                        placeholder="e.g. wear it open, over the t-shirt"
                        className="rounded-md border border-line bg-paper-3 px-3 py-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent" />
                </label>
                <p className="text-[11px] leading-relaxed text-ink-3">
                    Images run on Nano Banana 2 and the 5s animation on Seedance Mini — billed to this project like any studio generation.
                </p>
            </aside>
        </div>
    );
}
