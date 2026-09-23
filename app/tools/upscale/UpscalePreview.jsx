'use client';

import { useEffect } from 'react';
import { ChevronLeft, ChevronRight, Copy, Download, Film, Maximize2, RotateCcw, X } from 'lucide-react';
import { UPSCALE_CODECS, UPSCALE_SCENES, UPSCALE_STYLES, UPSCALE_VERSIONS, bitrateApplies, proTier } from '../../../lib/byteplus/upscaleOptions.mjs';
import { usd } from '../../../lib/seedance/money.mjs';
import { ACTIVE, minutesLeft } from './UpscaleRail.jsx';

const label = (list, v) => list.find((x) => x.value === v)?.label ?? v ?? '—';
const fmtDate = (v) => (v ? new Date(v).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : null);
const STATUS_TEXT = { queued: 'Queued', processing: 'Upscaling', succeeded: 'Done', failed: 'Failed', cancelled: 'Cancelled', rejected: 'Rejected' };

// Full-screen preview for one upscale, same layout as the studio's: stage on
// the left, every setting + actions on the right. Esc closes, ←/→ step.
export default function UpscalePreview({ job, onClose, onPrev, onNext, onReuse }) {
    useEffect(() => {
        const onKey = (e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowLeft' && onPrev) onPrev();
            else if (e.key === 'ArrowRight' && onNext) onNext();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose, onPrev, onNext]);

    const o = job.options || {};
    const pro = o.version === 'professional';
    const meta = job.metadata || {};

    return (
        <div role="dialog" aria-modal="true" aria-label={`${job.name} preview`} className="fixed inset-0 z-50 flex flex-col bg-app-bg/95 backdrop-blur-sm lg:flex-row">
            <div className="relative flex min-h-[40vh] flex-1 items-center justify-center bg-black p-4">
                <Stage job={job} />
                <button type="button" onClick={onClose} aria-label="Close preview" className="absolute left-4 top-4 rounded-full border border-white/10 bg-black/60 p-2 text-white/80 hover:text-white lg:hidden"><X size={18} /></button>
                {onPrev && <NavButton side="left" onClick={onPrev} />}
                {onNext && <NavButton side="right" onClick={onNext} />}
            </div>

            <aside className="flex w-full shrink-0 flex-col border-t border-line bg-paper-1 lg:h-full lg:w-[360px] lg:border-l lg:border-t-0">
                <div className="flex items-center justify-between border-b border-line px-4 py-3">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent text-accent-ink"><Maximize2 size={13} /></span>
                        <div className="min-w-0 leading-tight">
                            <div className="truncate text-xs font-semibold text-ink">{job.name}</div>
                            <div className="text-[11px] text-ink-3">Video Upscale · {STATUS_TEXT[job.status] || job.status}</div>
                        </div>
                    </div>
                    <button type="button" onClick={onClose} aria-label="Close preview" className="rounded-md p-1.5 text-ink-3 hover:bg-paper-3 hover:text-ink"><X size={16} /></button>
                </div>

                <div className="custom-scrollbar flex-1 overflow-y-auto">
                    <Section title="Source">
                        <div className="flex items-center gap-3">
                            <div className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-lg border border-line bg-black">
                                {job.sourceUrl
                                    ? <video src={job.sourceUrl} muted playsInline preload="metadata" className="h-full w-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                                    : null}
                                <span className="absolute inset-x-0 bottom-0 bg-black/70 py-0.5 text-center text-[9px] font-semibold text-accent-hi">Source</span>
                            </div>
                            <dl className="min-w-0 flex-1 space-y-1 text-[11px]">
                                <Row k="Length" v={job.source?.seconds ? `${Number(job.source.seconds).toFixed(1)}s` : null} />
                                <Row k="Size" v={job.source?.width ? `${job.source.width}×${job.source.height}` : null} />
                            </dl>
                        </div>
                    </Section>

                    <Section title="Settings">
                        <dl className="space-y-2 text-xs">
                            <Row k="Version" v={label(UPSCALE_VERSIONS, o.version)} />
                            {pro && <Row k="Tier" v={proTier(o)} />}
                            <Row k="Scene" v={label(UPSCALE_SCENES, o.scene)} />
                            <Row k="Style" v={label(UPSCALE_STYLES, o.style)} />
                            <Row k="Resolution" v={o.resolutionMode === 'limit' ? `${o.shortSide}px short side` : o.resolutionMode === 'source' ? 'Keep source' : String(o.resolution || '').toUpperCase()} />
                            <Row k="Frame rate" v={o.fpsMode === 'custom' ? `${o.fps} fps` : 'Keep source'} />
                            <Row k="Bitrate" v={!bitrateApplies(o) ? 'Automatic' : o.bitrateMode === 'kbps' ? `${Number(o.kbps).toLocaleString()} kbps` : `${o.bitrateLevel?.[0]?.toUpperCase()}${o.bitrateLevel?.slice(1)} level`} />
                            {pro && <Row k="Codec" v={label(UPSCALE_CODECS, o.codec)} />}
                            {pro && <Row k="Bit depth" v={`${o.bitDepth}-bit`} />}
                            <Row k="Container" v={`.${job.container}`} />
                        </dl>
                    </Section>

                    {job.status === 'succeeded' && (meta.resolution || meta.fps || meta.duration) ? (
                        <Section title="Output">
                            <dl className="space-y-2 text-xs">
                                <Row k="Resolution" v={meta.resolution} />
                                <Row k="Frame rate" v={meta.fps ? `${Number(meta.fps).toFixed(3).replace(/\.?0+$/, '')} fps` : null} />
                                <Row k="Duration" v={meta.duration ? `${Number(meta.duration).toFixed(2)}s` : null} />
                            </dl>
                        </Section>
                    ) : null}

                    <Section title="Details" last>
                        <dl className="space-y-2 text-xs">
                            <Row k="Status" v={ACTIVE.has(job.status) && minutesLeft(job) ? `${STATUS_TEXT[job.status]} · ~${minutesLeft(job)} min left` : STATUS_TEXT[job.status] || job.status} />
                            <Row k="Estimated" v={job.estimateUsd != null ? usd(job.estimateUsd) : null} />
                            <Row k="Charged" v={job.costUsd != null ? usd(job.costUsd) : job.status === 'succeeded' ? null : '—'} />
                            <Row k="Created" v={fmtDate(job.createdAt)} />
                            <Row k="Finished" v={fmtDate(job.finishedAt)} />
                            <Row k="Job" v={<span className="font-mono text-[10px]">UPS-{job.id}</span>} />
                            {job.providerTaskId && <Row k="Task" v={<span className="break-all font-mono text-[10px]">{job.providerTaskId}</span>} />}
                        </dl>
                        {job.error && <p className="mt-3 text-xs text-danger">{job.error}</p>}
                        {job.status === 'succeeded' && !job.durable && <p className="mt-3 text-[11px] text-warn">Temporary BytePlus link — download within 24h.</p>}
                    </Section>
                </div>

                <div className="space-y-2 border-t border-line p-3">
                    <button type="button" onClick={() => { onReuse(o); onClose(); }} title="Load these settings back into the upscale form"
                        className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2.5 text-xs font-semibold text-accent-ink transition-colors hover:bg-accent-hi">
                        <RotateCcw size={13} /> Reuse these settings
                    </button>
                    <div className="flex gap-2">
                        {job.status === 'succeeded' && job.url && (
                            <a href={job.url} target="_blank" rel="noreferrer" download
                                className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-line px-3 py-2.5 text-xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink">
                                <Download size={13} /> Download .{job.container}
                            </a>
                        )}
                        {job.providerTaskId && (
                            <button type="button" onClick={() => navigator.clipboard?.writeText(job.providerTaskId)} title="Copy the BytePlus task id"
                                className="flex items-center justify-center gap-1.5 rounded-md border border-line px-3 py-2.5 text-xs font-semibold text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink">
                                <Copy size={13} /> Task
                            </button>
                        )}
                    </div>
                </div>
            </aside>
        </div>
    );
}

function Stage({ job }) {
    if (job.status === 'succeeded' && job.url && job.container === 'mp4') {
        return <video key={job.id} src={job.url} controls autoPlay loop playsInline className="max-h-full max-w-full object-contain" />;
    }
    if (job.status === 'succeeded') {
        return (
            <div className="flex flex-col items-center gap-2 text-center text-ink-3">
                <Film size={28} />
                <p className="text-sm text-ink-2">.{job.container} output</p>
                <p className="max-w-xs text-xs">Browsers can’t play ProRes / FFV1. Download it and open in DaVinci Resolve, Premiere or QuickTime.</p>
            </div>
        );
    }
    const active = ACTIVE.has(job.status);
    return (
        <div className="relative flex h-full w-full items-center justify-center">
            {job.sourceUrl && <video src={job.sourceUrl} muted playsInline autoPlay loop className="max-h-full max-w-full object-contain opacity-40" onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
            <div className="absolute flex flex-col items-center gap-2 rounded-xl bg-black/60 px-5 py-4 text-center backdrop-blur-sm">
                {active ? (
                    <>
                        <span className="inline-block animate-spin text-2xl text-accent-hi">◌</span>
                        <span className="text-sm font-semibold text-ink">{job.status === 'queued' ? 'Queued' : 'Upscaling'}</span>
                        {minutesLeft(job) && <span className="text-xs text-ink-3">About {minutesLeft(job)} min left · you can close this page</span>}
                    </>
                ) : (
                    <span className="max-w-xs text-sm text-danger">{job.error || `Upscale ${job.status}.`}</span>
                )}
            </div>
        </div>
    );
}

function NavButton({ side, onClick }) {
    const Icon = side === 'left' ? ChevronLeft : ChevronRight;
    return (
        <button type="button" onClick={onClick} aria-label={side === 'left' ? 'Previous' : 'Next'}
            className={`absolute top-1/2 z-10 -translate-y-1/2 rounded-full border border-white/10 bg-black/60 p-2.5 text-white/80 backdrop-blur-sm hover:text-white ${side === 'left' ? 'left-3 sm:left-5' : 'right-3 sm:right-5'}`}>
            <Icon size={20} />
        </button>
    );
}

function Section({ title, children, last }) {
    return (
        <section className={`px-4 py-3 ${last ? '' : 'border-b border-line'}`}>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">{title}</div>
            {children}
        </section>
    );
}

function Row({ k, v }) {
    if (v == null || v === '') return null;
    return (
        <div className="flex items-start justify-between gap-3">
            <dt className="shrink-0 text-ink-3">{k}</dt>
            <dd className="text-right font-medium text-ink-2">{v}</dd>
        </div>
    );
}
