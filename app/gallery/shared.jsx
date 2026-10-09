'use client';

// Shared building blocks for the generation-browsing pages (/gallery and
// /liked): video cards with hover preview, the full lightbox view, the
// archived→live URL fallback player, and the Reuse-in-Studio handoff.

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ChevronLeft, ChevronRight, Download, RotateCcw, X } from 'lucide-react';
import { MODES } from '../../lib/seedance/constants.js';
import { downloadArchivedAsset, downloadAsset } from '../../lib/seedance/downloadAssets.js';
import { estimateExrCost, EXR_DEFAULT_OPTIONS, EXR_FPS, EXR_RESOLUTIONS, EXR_TIERS, normalizeExrOptions, pricePerExrMinute } from '../../lib/byteplus/exrPricing.mjs';
import BudgetRequestModal from '../seedance/BudgetRequestModal.jsx';
import VideoDownloadFormat from '../seedance/VideoDownloadFormat.jsx';
import DownloadProgress, { useDownloadProgress } from '../seedance/DownloadProgress.jsx';
import { formatGenerationTime, GENERATION_TIME_DESCRIPTION } from '../../lib/seedance/generationTime.mjs';
import VideoThumbnail from '../seedance/VideoThumbnail.jsx';

export const modeNameOf = (id) => MODES.find((m) => m.id === id)?.name ?? null;

// Deterministic avatar gradient per user id — stable across reloads.
const GRADIENTS = [
    'from-cyan-400 to-blue-600',
    'from-fuchsia-400 to-purple-600',
    'from-amber-300 to-orange-600',
    'from-emerald-400 to-teal-600',
    'from-rose-400 to-red-600',
    'from-indigo-400 to-violet-600',
];
export const gradientFor = (id) => GRADIENTS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % GRADIENTS.length];
export const initialOf = (c) => (c.name || c.email || '?').trim().charAt(0).toUpperCase();

export function timeAgo(iso) {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString();
}

// Defer a card's work until it nears the viewport. Without this, a grid of
// N cards fires N task-fetches + N video metadata loads on mount at once —
// which is why /gallery and /liked stalled with hundreds of black tiles.
// Latches on first intersection and stays true (no re-fetch thrash on scroll).
// 200px lookahead: enough to feel instant on scroll without prefetching rows
// of media the user may never reach (which crushed slow connections).
function useInView(rootMargin = '200px', once = true) {
    const ref = useRef(null);
    const [inView, setInView] = useState(false);
    useEffect(() => {
        const el = ref.current;
        if (!el || (once && inView)) return;
        if (typeof IntersectionObserver === 'undefined') { setInView(true); return; }
        const obs = new IntersectionObserver(([e]) => {
            if (e.isIntersecting || !once) setInView(e.isIntersecting);
            if (e.isIntersecting && once) obs.disconnect();
        }, { rootMargin });
        obs.observe(el);
        return () => obs.disconnect();
    }, [inView, rootMargin, once]);
    return [ref, inView];
}

// Hand the full setup (prompt, refs, settings, mode) to the studio via
// localStorage — the studio applies + clears it on mount. Presigned ref URLs
// expire, so tosKey-backed refs are re-presigned first; otherwise an old
// generation would be reused with dead reference links.
export async function reuseInStudio(router, item) {
    const refs = await Promise.all((item.refs || []).map(async (r) => {
        if (!r?.tosKey) return r;
        try {
            const res = await fetch(`/api/byteplus/archive?key=${encodeURIComponent(r.tosKey)}`);
            const d = res.ok ? await res.json() : null;
            return d?.url ? { ...r, url: d.url, previewUrl: d.url } : r;
        } catch {
            return r;
        }
    }));
    try {
        localStorage.setItem('seedance:reuse', JSON.stringify({
            mediaType: item.mediaType || 'video',
            modeId: item.mode,
            style: item.style,
            userPrompt: item.userPrompt,
            prompt: item.prompt,
            refs: refs.length ? refs : null,
            options: { model: item.modelId, resolution: item.resolution, duration: item.duration, ratio: item.ratio },
        }));
    } catch { /* private mode etc. — the studio just opens blank */ }
    router.push('/seedance');
}

// One generation in the grid: hover to preview, click for the full view.
// `creator` (optional) puts the maker's avatar chip on the card — used on
// pages that mix creators (/liked); the per-creator gallery omits it.
export function VideoCard({ item, creator, onOpen, exrAccess }) {
    const [wrapRef, inView] = useInView('0px', false);
    const [hovered, setHovered] = useState(false);
    const prompt = item.userPrompt || item.prompt || '';
    return (
        <div
            ref={wrapRef}
            role="button"
            tabIndex={0}
            onClick={onOpen}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            className="group relative aspect-video rounded-2xl overflow-hidden border border-white/10 bg-black/50 cursor-pointer hover:border-white/30 transition-all hover:shadow-xl hover:shadow-black/40"
            title={prompt}
        >
            <VideoThumbnail key={item.taskId} item={item} visible={inView} hovered={hovered && inView} Player={SmartVideo} />
            {/* Bottom info gradient */}
            <div className="absolute inset-x-0 bottom-0 p-2.5 pt-8 bg-gradient-to-t from-black/85 to-transparent pointer-events-none">
                {prompt && <p className="text-[11px] leading-snug text-white/85 line-clamp-2">{prompt}</p>}
                <div className="flex items-center gap-1.5 mt-1.5 text-[9px] font-bold text-white/45">
                    <span className="px-1.5 py-0.5 rounded bg-white/10 text-white/70">{item.modelName}</span>
                    {item.resolution && <span>{item.resolution}</span>}
                    {item.duration ? <span>{item.duration}s</span> : null}
                    <span className="ml-auto font-medium">{timeAgo(item.createdAt)}</span>
                </div>
            </div>
            {creator ? (
                <span className="absolute top-2 left-2 flex items-center gap-1.5 pl-0.5 pr-2 py-0.5 rounded-full bg-black/60 border border-white/15 backdrop-blur-sm">
                    <span className={`w-4 h-4 rounded-full bg-gradient-to-br ${gradientFor(creator.id)} flex items-center justify-center text-[8px] font-black text-black/80`}>{initialOf(creator)}</span>
                    <span className="text-[9px] font-semibold text-white/75 max-w-28 truncate">{creator.name || creator.email}</span>
                </span>
            ) : item.liked && (
                <span className="absolute top-2 left-2 w-5 h-5 rounded-full bg-black/60 border border-rose-400/40 text-rose-400 flex items-center justify-center">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" /></svg>
                </span>
            )}
            {exrAccess?.granted && item.exrUrl && (
                <div className="absolute right-2 top-2 flex gap-1">
                    <button
                        type="button"
                        onClick={(event) => {
                            event.stopPropagation();
                            downloadArchivedAsset(item.exrArchiveKey, item.exrUrl, `${item.taskId || 'generation'}-16bit.mov`, item.taskId, { raw: true });
                        }}
                        title="Download the original 16-bit output"
                        aria-label="Download the original 16-bit output"
                        className="flex items-center gap-1 rounded-md border border-white/20 bg-black/70 px-2 py-1 text-[9px] font-bold text-white/75 backdrop-blur-sm transition-colors hover:border-white/45 hover:bg-white/10"
                    >
                        Original 16-bit
                    </button>
                </div>
            )}
        </div>
    );
}

// One generated image in the grid — same chrome as VideoCard, but a still.
// No hover-preview (nothing to play); an "Image" tag distinguishes it in a
// mixed grid. The presigned URL is long-lived (7 days), so no fallback dance.
export function ImageCard({ item, creator, onOpen }) {
    const [wrapRef, inView] = useInView();
    const prompt = item.userPrompt || item.prompt || '';
    return (
        <div
            ref={wrapRef}
            role="button"
            tabIndex={0}
            onClick={onOpen}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
            className="group relative aspect-video rounded-2xl overflow-hidden border border-white/10 bg-black/50 cursor-pointer hover:border-white/30 transition-all hover:shadow-xl hover:shadow-black/40"
            title={prompt}
        >
            {inView && item.imageUrl
                ? <img src={item.imageUrl} alt={prompt} loading="lazy" className="w-full h-full object-cover bg-black" />
                : <div className="w-full h-full bg-white/[0.03] animate-pulse" />}
            <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-black/60 border border-white/15 text-[8px] font-black uppercase tracking-wider text-white/70 pointer-events-none">Image</span>
            <div className="absolute inset-x-0 bottom-0 p-2.5 pt-8 bg-gradient-to-t from-black/85 to-transparent pointer-events-none">
                {prompt && <p className="text-[11px] leading-snug text-white/85 line-clamp-2">{prompt}</p>}
                <div className="flex items-center gap-1.5 mt-1.5 text-[9px] font-bold text-white/45">
                    <span className="px-1.5 py-0.5 rounded bg-white/10 text-white/70">{item.modelName}</span>
                    {item.resolution && <span>{item.resolution}</span>}
                    <span className="ml-auto font-medium">{timeAgo(item.createdAt)}</span>
                </div>
            </div>
            {creator ? (
                <span className="absolute top-2 left-2 flex items-center gap-1.5 pl-0.5 pr-2 py-0.5 rounded-full bg-black/60 border border-white/15 backdrop-blur-sm">
                    <span className={`w-4 h-4 rounded-full bg-gradient-to-br ${gradientFor(creator.id)} flex items-center justify-center text-[8px] font-black text-black/80`}>{initialOf(creator)}</span>
                    <span className="text-[9px] font-semibold text-white/75 max-w-28 truncate">{creator.name || creator.email}</span>
                </span>
            ) : item.liked && (
                <span className="absolute top-2 left-2 w-5 h-5 rounded-full bg-black/60 border border-rose-400/40 text-rose-400 flex items-center justify-center">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" /></svg>
                </span>
            )}
        </div>
    );
}

// Video with a two-step URL fallback: the archived TOS copy (long-lived,
// presigned server-side) → the live ModelArk task record (~24h) → a
// placeholder. `videoRef`/`onUrl` let parents control playback / download.
export function SmartVideo({ item, videoRef, onUrl, onUnavailable, className, ...videoProps }) {
    const [src, setSrc] = useState(item.archiveUrl || null);
    const [phase, setPhase] = useState(item.archiveUrl ? 'archive' : 'task');
    const [taskStatus, setTaskStatus] = useState(null);
    const triedTask = useRef(false);

    const fetchTask = () => {
        if (triedTask.current) { setPhase('dead'); setSrc(null); return; }
        triedTask.current = true;
        fetch(`/api/byteplus/contents/generations/tasks/${encodeURIComponent(item.taskId)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                const url = d?.content?.video_url;
                if (url) { setSrc(url); setPhase('live'); }
                else { setTaskStatus(d?.status || null); setPhase('dead'); setSrc(null); }
            })
            .catch(() => { setPhase('dead'); setSrc(null); });
    };

    useEffect(() => {
        if (!item.archiveUrl) fetchTask();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => { if (src) onUrl?.(src); }, [src, onUrl]);
    useEffect(() => { if (phase === 'dead') onUnavailable?.(); }, [phase, onUnavailable]);

    if (phase === 'dead') {
        const rendering = ['queued', 'running'].includes(taskStatus);
        return (
            <div className={`${className} flex flex-col items-center justify-center gap-1.5 text-white/25`}>
                {rendering ? (
                    <>
                        <span className="animate-spin inline-block text-primary text-sm">◌</span>
                        <span className="text-[10px] font-semibold text-white/40">Still rendering…</span>
                    </>
                ) : (
                    <>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
                        <span className="text-[10px] font-semibold">Video no longer available</span>
                    </>
                )}
            </div>
        );
    }
    if (!src) return <div className={`${className} animate-pulse bg-white/[0.03]`} />;
    return (
        <video
            ref={videoRef}
            src={src}
            className={className}
            onError={() => { if (phase === 'archive') fetchTask(); else { setPhase('dead'); setSrc(null); } }}
            {...videoProps}
        />
    );
}

// Full-screen Studio-style preview, shared by Community Gallery and Liked.
export function Lightbox({ item, creator, onClose, onReuse, onPrev, onNext, onExrReady, exrAccess, exrAccessRequesting, onRequestExrAccess }) {
    const isImage = item.mediaType === 'image';
    const imageUrls = (item.imageUrls?.length ? item.imageUrls : [item.imageUrl]).filter(Boolean);
    const [dlUrl, setDlUrl] = useState(isImage ? imageUrls[0] || null : null);
    const [dlFormat, setDlFormat] = useState('mov');
    const { pending: downloadPending, runDownload } = useDownloadProgress();
    const [videoDuration, setVideoDuration] = useState(Number(item.duration) > 0 ? Number(item.duration) : null);
    const [showExrDialog, setShowExrDialog] = useState(false);
    const [promptTab, setPromptTab] = useState('yours');
    const [copied, setCopied] = useState(false);
    const [copyError, setCopyError] = useState(false);
    const prompt = item.userPrompt || item.prompt || '';
    const hasBoth = !!item.userPrompt && !!item.prompt && item.userPrompt !== item.prompt;
    const shownPrompt = promptTab === 'enhanced' && hasBoth ? item.prompt : prompt;
    const created = item.createdAt ? new Date(item.createdAt) : null;
    const createdText = created && !Number.isNaN(created.getTime())
        ? created.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null;

    useEffect(() => { setCopied(false); setCopyError(false); }, [shownPrompt]);
    const copyPrompt = async () => {
        try { await navigator.clipboard.writeText(shownPrompt); setCopied(true); setCopyError(false); }
        catch { setCopyError(true); }
    };
    const navigate = (event) => {
        if (event.defaultPrevented || showExrDialog || event.target.closest('input, textarea, select, [role="combobox"], [role="listbox"], [role="tablist"], [contenteditable="true"]')) return;
        if (event.key === 'ArrowLeft' && onPrev) { event.preventDefault(); onPrev(); }
        if (event.key === 'ArrowRight' && onNext) { event.preventDefault(); onNext(); }
    };
    const details = [
        ['Model', item.modelName || item.modelId],
        ['Resolution', item.resolution],
        ['EXR resolution', item.exrResolution],
        ['Duration', item.duration ? `${item.duration}s` : null],
        ['Aspect ratio', item.ratio && item.ratio !== 'adaptive' ? item.ratio : null],
        ['Mode', modeNameOf(item.mode)],
        ['Project', item.projectName],
        ['Created', createdText],
        ['Generation time', !isImage ? <span title={GENERATION_TIME_DESCRIPTION} className="tabular-nums">{formatGenerationTime(item.submittedAt, item.finishedAt) ?? 'Not recorded'}</span> : null],
    ].filter(([, value]) => value);

    return (
        <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogContent
                aria-describedby={undefined}
                onKeyDown={navigate}
                onEscapeKeyDown={(event) => {
                    if (showExrDialog) { event.preventDefault(); setShowExrDialog(false); }
                }}
                className="inset-0 left-0 top-0 z-[100] flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-app-bg p-0 text-ink shadow-none sm:rounded-none lg:flex-row [&>button]:hidden data-[state=open]:animate-none data-[state=closed]:animate-none"
                overlayClassName="z-[99] bg-black"
            >
                <DialogTitle className="sr-only">Generation preview</DialogTitle>
                <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
                    {isImage ? (
                        imageUrls.length ? (
                            <div className={`flex h-full w-full min-h-0 items-center justify-center gap-2 ${imageUrls.length > 1 ? 'flex-wrap overflow-y-auto p-2' : ''}`}>
                                {imageUrls.map((url, index) => (
                                    <img key={url} src={url} alt={prompt || `Generated image ${index + 1}`} className={imageUrls.length > 1 ? 'max-h-[45%] max-w-[48%] object-contain' : 'max-h-full max-w-full object-contain'} />
                                ))}
                            </div>
                        ) : <p className="text-sm text-ink-3">Image no longer available</p>
                    ) : (
                        <SmartVideo key={item.taskId} item={item} onUrl={setDlUrl}
                            onLoadedMetadata={(event) => {
                                const duration = event.currentTarget.duration;
                                if (Number.isFinite(duration) && duration > 0) setVideoDuration(duration);
                            }}
                            className="max-h-full max-w-full object-contain" controls autoPlay loop playsInline />
                    )}
                    <button type="button" onClick={onClose} aria-label="Close preview" className="absolute left-4 top-4 z-10 rounded-full border border-white/10 bg-black/60 p-2 text-white/80 hover:bg-black/80 hover:text-white lg:hidden"><X size={18} /></button>
                    {onPrev && <button type="button" onClick={onPrev} aria-label="Previous generation" className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full border border-white/10 bg-black/60 p-2.5 text-white/80 transition-colors hover:bg-black/80 hover:text-white sm:left-5"><ChevronLeft size={20} /></button>}
                    {onNext && <button type="button" onClick={onNext} aria-label="Next generation" className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full border border-white/10 bg-black/60 p-2.5 text-white/80 transition-colors hover:bg-black/80 hover:text-white sm:right-5"><ChevronRight size={20} /></button>}
                </div>

                <aside className="flex max-h-[55dvh] min-h-0 w-full shrink-0 flex-col border-t border-line bg-paper-1 lg:h-full lg:max-h-none lg:w-[360px] lg:border-l lg:border-t-0">
                    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-3">
                        <div className="flex min-w-0 items-center gap-2">
                            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent font-display text-xs font-bold text-accent-ink">{creator ? initialOf(creator) : 'S'}</span>
                            <div className="min-w-0 leading-tight">
                                <div className="truncate text-xs font-semibold text-ink">{creator?.name || creator?.email || 'Community generation'}</div>
                                <div className="truncate text-[11px] text-ink-3">{item.modelName || item.modelId || (isImage ? 'Image' : 'Video')}</div>
                            </div>
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close preview" className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink"><X size={16} /></button>
                    </header>
                    <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
                        <section className="border-b border-line px-4 py-3">
                            <div className="mb-2 flex items-center justify-between gap-2">
                                {hasBoth ? (
                                    <div className="flex items-center gap-1" role="group" aria-label="Prompt version">
                                        {[['yours', 'Original prompt'], ['enhanced', 'Enhanced prompt']].map(([id, label]) => (
                                            <button key={id} type="button" aria-pressed={promptTab === id} onClick={() => setPromptTab(id)} className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${promptTab === id ? 'bg-accent/15 text-accent-hi' : 'text-ink-3 hover:text-ink'}`}>{label}</button>
                                        ))}
                                    </div>
                                ) : <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Prompt</span>}
                                {shownPrompt && <button type="button" onClick={copyPrompt} className="shrink-0 text-[11px] font-medium text-ink-3 hover:text-ink">{copied ? 'Copied' : 'Copy'}</button>}
                            </div>
                            <p className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-2">{shownPrompt || 'No prompt recorded for this generation.'}</p>
                            {copyError && <p role="status" className="mt-2 text-xs text-danger">Couldn’t copy. Select the prompt text to copy it.</p>}
                        </section>
                        {item.style && <section className="border-b border-line px-4 py-3"><h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Style applied</h3><p className="text-xs text-ink-2">{item.style}</p></section>}
                        {item.refs?.length > 0 && <section className="border-b border-line px-4 py-3"><RefStrip refs={item.refs} /></section>}
                        <section className="px-4 py-3">
                            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Details</h3>
                            <dl className="space-y-2 text-xs">
                                {details.map(([label, value]) => <div key={label} className="flex items-start justify-between gap-3"><dt className="shrink-0 text-ink-3">{label}</dt><dd className="break-words text-right font-medium text-ink-2">{value}</dd></div>)}
                                {item.taskId && <div className="flex items-start justify-between gap-3"><dt className="text-ink-3">Task</dt><dd className="min-w-0 break-all text-right font-mono text-[10px] text-ink-2">{item.taskId}</dd></div>}
                            </dl>
                        </section>
                    </div>
                    <footer className="shrink-0 space-y-2 border-t border-line p-3">
                        <Button type="button" onClick={onReuse} className="h-auto w-full gap-1.5 px-3 py-2.5 text-xs font-medium shadow-none"><RotateCcw size={13} />Reuse this setup</Button>
                        {!isImage && !(exrAccess?.granted && item.exrUrl) && (
                            <button type="button" disabled={exrAccessRequesting || exrAccess?.status === 'pending'}
                                onClick={() => exrAccess?.granted ? setShowExrDialog(true) : onRequestExrAccess?.()}
                                title={exrAccess?.granted ? 'Generate a 16-bit EXR output' : 'Request EXR access'}
                                className="flex w-full items-center justify-center rounded-md border border-accent/40 bg-accent/10 px-3 py-2.5 text-xs font-semibold text-ink transition-colors hover:bg-accent/20 disabled:opacity-50">
                                {exrAccess?.granted ? 'EXR' : exrAccess?.status === 'pending' ? 'EXR access pending' : 'Request EXR access'}
                            </button>
                        )}
                        {!isImage && exrAccess?.granted && item.exrUrl && <Button type="button" variant="outline" className="h-auto w-full py-2 text-xs shadow-none" onClick={() => downloadArchivedAsset(item.exrArchiveKey, item.exrUrl, `${item.taskId || 'generation'}-16bit.mov`, item.taskId, { raw: true })}>Download original 16-bit output</Button>}
                        {!isImage && <VideoDownloadFormat value={dlFormat} onValueChange={setDlFormat} disabled={!!downloadPending} />}
                        <DownloadProgress pending={downloadPending} />
                        <div className="flex flex-wrap items-center gap-2">
                            <Button type="button" variant="outline" disabled={!dlUrl || !!downloadPending} aria-busy={!!downloadPending} className="h-auto flex-1 gap-1.5 px-3 py-2.5 text-xs shadow-none"
                                onClick={() => runDownload(() => downloadAsset(dlUrl, item.taskId || (isImage ? 'image' : 'video'), item.taskId, isImage ? undefined : { format: dlFormat === 'prores' ? 'prores' : dlFormat.startsWith('mp4') ? 'mp4' : 'mov', fps: dlFormat.endsWith('25') ? 25 : null }), isImage ? 'file' : 'video')}><Download size={13} />{downloadPending ? 'Processing…' : 'Download'}</Button>
                            {!isImage && (
                                <Button type="button" variant="outline" disabled={!dlUrl || !!downloadPending} onClick={() => runDownload(() => downloadAsset(dlUrl, item.taskId || 'generation', item.taskId, { raw: true }), 'file')} className="h-auto px-3 py-2.5 text-xs shadow-none">Original</Button>
                            )}
                        </div>
                    </footer>
                </aside>
                {showExrDialog && !isImage && <GalleryExrDialog item={item} sourceUrl={dlUrl} durationSeconds={videoDuration} projectId={exrAccess?.projectId} onClose={() => setShowExrDialog(false)} onReady={(url, archiveKey) => { setShowExrDialog(false); onExrReady?.(item.taskId, url, archiveKey); }} />}
            </DialogContent>
        </Dialog>
    );
}

function GalleryExrDialog({ item, sourceUrl, durationSeconds, projectId, onClose, onReady }) {
    const [options, setOptions] = useState(() => normalizeExrOptions(EXR_DEFAULT_OPTIONS));
    const [status, setStatus] = useState('idle');
    const [error, setError] = useState(null);
    // Budget rejection (NO_BUDGET / QUOTA_EXCEEDED) offers requesting an EXR
    // budget right here — the request lands in the admin Budget requests queue.
    const [errorCode, setErrorCode] = useState(null);
    const [budgetOpen, setBudgetOpen] = useState(false);
    const [budgetSent, setBudgetSent] = useState(false);
    const alive = useRef(true);
    const duration = Number(durationSeconds);
    const rate = pricePerExrMinute(options);
    const estimate = estimateExrCost(options, duration);

    useEffect(() => () => { alive.current = false; }, []);

    const setOption = (key, value) => {
        setOptions((current) => normalizeExrOptions({ ...current, [key]: value }));
    };

    const generate = async () => {
        if (!sourceUrl) {
            setError('The source video is still loading. Please wait a moment and try again.');
            return;
        }
        setStatus('submitting');
        setError(null);
        setErrorCode(null);
        try {
            const response = await fetch('/api/seedance/exr', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sourceUrl,
                    sourceTaskId: item.taskId,
                    projectId,
                    options,
                    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
                }),
            });
            const data = await response.json().catch(() => null);
            if (!response.ok || !data?.taskToken) {
                const err = new Error(data?.error || `EXR request failed (${response.status}).`);
                err.code = data?.code || null;
                throw err;
            }
            setStatus('processing');

            for (let attempt = 0; attempt < 360; attempt += 1) {
                if (!alive.current) return;
                if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 5000));
                const poll = await fetch(`/api/seedance/exr?task=${encodeURIComponent(data.taskToken)}`);
                const result = await poll.json().catch(() => null);
                if (!poll.ok) throw new Error(result?.error || `EXR status failed (${poll.status}).`);
                if (result?.status === 'queued' || result?.status === 'processing') continue;
                if (result?.status === 'failed' || result?.status === 'cancelled') {
                    throw new Error(result.error || 'EXR generation failed.');
                }
                if (result?.status === 'succeeded' && result.url) {
                    onReady(result.url, result.archiveKey || null);
                    return;
                }
                throw new Error('EXR generation returned no output file.');
            }
            throw new Error('Timed out waiting for the EXR file.');
        } catch (caught) {
            if (alive.current) {
                setStatus('error');
                setError(caught.message || 'EXR generation failed.');
                setErrorCode(caught.code || null);
            }
        }
    };

    return (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
            <section role="dialog" aria-modal="true" aria-labelledby="gallery-exr-dialog-title" className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-white/15 bg-[#111116] p-5 text-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-amber-300">BytePlus VOD MediaKit</p>
                        <h2 id="gallery-exr-dialog-title" className="mt-1 text-xl font-semibold">Generate 16-bit EXR</h2>
                        <p className="mt-1 text-xs text-white/45">Create a lossless 16-bit master (FFV1 MOV) from this Gallery video.</p>
                    </div>
                    <button type="button" onClick={onClose} aria-label="Close EXR dialog" className="rounded-lg p-1.5 text-white/45 transition-colors hover:bg-white/10 hover:text-white">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                    </button>
                </div>

                <div className="mt-5 grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
                    <GalleryDetailRow label="Format" value="FFV1 lossless · QuickTime MOV" />
                    <GalleryDetailRow label="Bit depth" value="16-bit 4:4:4" />
                    <GalleryExrSelect label="Enhancement" value={options.tier} onChange={(value) => setOption('tier', value)}>
                        {EXR_TIERS.map((tier) => <option key={tier.value} value={tier.value}>{tier.label}</option>)}
                    </GalleryExrSelect>
                    <GalleryExrSelect label="Resolution" value={options.resolution} onChange={(value) => setOption('resolution', value)}>
                        {EXR_RESOLUTIONS.map((resolution) => <option key={resolution.value} value={resolution.value}>{resolution.label}</option>)}
                    </GalleryExrSelect>
                    <GalleryExrSelect label="Frame rate" value={String(options.fps)} onChange={(value) => setOption('fps', Number(value))}>
                        {EXR_FPS.map((fps) => <option key={fps} value={fps}>{fps} FPS</option>)}
                    </GalleryExrSelect>
                    <GalleryDetailRow label="Billing unit" value="USD per output minute" />
                </div>

                <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.04] p-4 text-xs">
                    <div className="flex items-center justify-between gap-3">
                        <p className="font-semibold text-white">Price preview</p>
                        <span className="rounded-full bg-amber-300/10 px-2 py-1 text-[10px] font-semibold text-amber-200">USD</span>
                    </div>
                    <dl className="mt-3 space-y-2 text-white/60">
                        <GalleryDetailRow label="Video length" value={Number.isFinite(duration) && duration > 0 ? `${duration.toFixed(3)} seconds` : 'Video length unavailable'} />
                        <GalleryDetailRow label="Rate" value={`$${rate.toFixed(4)} / minute`} />
                        <GalleryDetailRow label="Calculation" value={estimate == null ? 'Waiting for video length' : `(${duration.toFixed(3)} ÷ 60) × $${rate.toFixed(4)}`} />
                    </dl>
                    <div className="mt-4 flex items-end justify-between border-t border-white/10 pt-3">
                        <span className="font-semibold text-white">Estimated total</span>
                        <strong className="text-lg text-amber-200">{estimate == null ? '—' : `$${estimate.toFixed(4)}`}</strong>
                    </div>
                </div>

                {error && <p className="mt-4 rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-xs text-red-200">{error}</p>}
                {['NO_BUDGET', 'QUOTA_EXCEEDED'].includes(errorCode) && !budgetSent && (
                    <button type="button" onClick={() => setBudgetOpen(true)}
                        className="mt-2 w-full rounded-lg border border-amber-300/35 bg-amber-300/10 px-3 py-2 text-xs font-semibold text-amber-200 transition-colors hover:bg-amber-300/20">
                        Request EXR budget
                    </button>
                )}
                {budgetSent && <p className="mt-2 rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-xs text-amber-200">Budget request sent — an admin will review it.</p>}
                {budgetOpen && projectId && (
                    <BudgetRequestModal projectId={projectId} initialModelId="tool:exr"
                        onClose={() => setBudgetOpen(false)}
                        onSent={() => { setBudgetOpen(false); setBudgetSent(true); }} />
                )}
                {status === 'processing' && <p className="mt-4 text-xs text-amber-200">EXR is processing. You can keep this window open while we check the status.</p>}

                <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <button type="button" onClick={onClose} className="rounded-lg border border-white/10 px-4 py-2.5 text-xs font-semibold text-white/65 transition-colors hover:bg-white/10 hover:text-white">Cancel</button>
                    <button
                        type="button"
                        onClick={generate}
                        disabled={status === 'submitting' || status === 'processing'}
                        className="rounded-lg bg-amber-300 px-4 py-2.5 text-xs font-bold text-black transition-colors hover:bg-amber-200 disabled:cursor-wait disabled:opacity-50"
                    >
                        {status === 'submitting' ? 'Submitting…' : status === 'processing' ? 'Processing…' : 'Confirm and generate EXR'}
                    </button>
                </div>
            </section>
        </div>
    );
}

function GalleryDetailRow({ label, value }) {
    return (
        <div className="flex items-start justify-between gap-3">
            <dt className="shrink-0 text-white/40">{label}</dt>
            <dd className="text-right font-medium text-white/75">{value}</dd>
        </div>
    );
}

function GalleryExrSelect({ label, value, onChange, children }) {
    return (
        <label className="flex items-center justify-between gap-3">
            <span className="shrink-0 text-white/40">{label}</span>
            <select value={value} onChange={(event) => onChange(event.target.value)} className="min-w-28 rounded-lg border border-white/10 bg-white/[0.06] px-2 py-1.5 text-right font-medium text-white/75 outline-none transition-colors hover:bg-white/10 focus:border-amber-300/60">
                {children}
            </select>
        </label>
    );
}

// Reference assets attached to the generation. Presigned preview links expire,
// so tosKey-backed refs are refreshed via the archive re-presign endpoint.
export function RefStrip({ refs }) {
    const [items, setItems] = useState(refs);
    useEffect(() => {
        let alive = true;
        Promise.all(refs.map(async (r) => {
            if (!r?.tosKey) return r;
            try {
                const res = await fetch(`/api/byteplus/archive?key=${encodeURIComponent(r.tosKey)}`);
                const d = res.ok ? await res.json() : null;
                return d?.url ? { ...r, previewUrl: d.url } : r;
            } catch {
                return r;
            }
        })).then((next) => { if (alive) setItems(next); });
        return () => { alive = false; };
    }, [refs]);

    const counters = {};
    return (
        <div>
            <p className="text-[9px] font-bold uppercase tracking-wider text-white/30 pb-1.5">References · {items.length}</p>
            <div className="flex gap-2 flex-wrap">
                {items.map((r, i) => {
                    counters[r.kind] = (counters[r.kind] || 0) + 1;
                    const tag = `${r.kind === 'image' ? 'Image' : r.kind === 'video' ? 'Video' : 'Audio'} ${counters[r.kind]}`;
                    return (
                        <div key={i} className="relative w-14 h-14 rounded-lg overflow-hidden border border-white/10 bg-black/40" title={r.name || tag}>
                            {r.kind === 'image' && r.previewUrl ? (
                                <img src={r.previewUrl} alt={r.name || tag} className="w-full h-full object-cover" />
                            ) : r.kind === 'video' && r.previewUrl ? (
                                <video src={r.previewUrl} muted playsInline preload="metadata" className="w-full h-full object-cover bg-black" />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center text-primary/60">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>
                                </div>
                            )}
                            <span className="absolute bottom-0 inset-x-0 px-1 py-0.5 bg-black/75 text-[7px] font-black text-primary text-center truncate pointer-events-none">{tag}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
