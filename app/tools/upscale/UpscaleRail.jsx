'use client';

import { Film } from 'lucide-react';

export const ACTIVE = new Set(['queued', 'processing']);

// Minutes left on the BytePlus RTF estimate, never below 1 while running.
export function minutesLeft(job) {
    if (!job.waitMin || !job.createdAt) return null;
    const elapsed = (Date.now() - new Date(job.createdAt).getTime()) / 60000;
    return Math.max(1, Math.round(job.waitMin - elapsed));
}

// Right-side history rail, same shape as the studio's: every upscale as a
// compact tile — click to open the preview with its full settings.
export default function UpscaleRail({ jobs, selectedId, onSelect, loading }) {
    return (
        <div className="mb-6 flex flex-col sm:fixed sm:bottom-4 sm:right-3 sm:top-16 sm:z-20 sm:mb-0 sm:w-44">
            <p className="px-1 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-ink-3 sm:pb-2">History · {jobs.length}</p>
            <div className="custom-scrollbar flex min-h-0 flex-1 gap-2 overflow-x-auto overflow-y-hidden pb-1 sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto sm:pb-0 sm:pr-0.5">
                {jobs.map((job) => (
                    <Tile key={job.id} job={job} selected={job.id === selectedId} onClick={() => onSelect(job.id)} />
                ))}
                {!jobs.length && (
                    <p className="px-1 text-[11px] leading-relaxed text-ink-3">{loading ? 'Loading…' : 'Your upscales appear here.'}</p>
                )}
            </div>
            <p className="hidden px-1 pt-2 text-[9px] leading-relaxed text-ink-3/70 sm:block">Synced to your account · outputs archived to team storage</p>
        </div>
    );
}

function Tile({ job, selected, onClick }) {
    const active = ACTIVE.has(job.status);
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onClick}
            onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
            title={`${job.name} — ${job.summary}`}
            className={`group relative aspect-video w-28 shrink-0 cursor-pointer overflow-hidden rounded-lg border bg-black transition-all sm:w-auto ${selected ? 'border-accent/70 ring-1 ring-accent/40' : 'border-line hover:border-line-strong'}`}
        >
            {job.status === 'succeeded' && job.url && job.container === 'mp4' ? (
                <video src={job.url} muted playsInline preload="metadata" loop
                    onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                    onMouseLeave={(e) => { e.currentTarget.pause(); }}
                    className="h-full w-full object-cover" />
            ) : job.status === 'succeeded' ? (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-ink-3">
                    <Film size={16} />
                    <span className="text-[9px] font-semibold uppercase">.{job.container}</span>
                </div>
            ) : (
                <>
                    {/* The source clip, dimmed, behind the status — so a running tile is recognizable. */}
                    {active && job.sourceUrl && job.source?.width
                        ? <video src={job.sourceUrl} muted playsInline preload="metadata" className="absolute inset-0 h-full w-full object-cover opacity-30" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                        : null}
                    <div className="relative flex h-full w-full flex-col items-center justify-center gap-1 bg-black/40 px-2 text-center">
                        {active ? (
                            <>
                                <span className="inline-block animate-spin text-sm text-accent-hi">◌</span>
                                <span className="text-[9px] font-semibold text-ink-2">
                                    {job.status === 'queued' ? 'Queued' : 'Upscaling'}{minutesLeft(job) ? ` · ~${minutesLeft(job)}m` : ''}
                                </span>
                            </>
                        ) : (
                            <span className="line-clamp-3 text-[9px] leading-tight text-danger" title={job.error || undefined}>{job.error || `Upscale ${job.status}`}</span>
                        )}
                    </div>
                </>
            )}
            <span className="absolute bottom-0 inset-x-0 truncate bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-3 text-[9px] font-medium text-white/80">
                {job.name}
            </span>
        </div>
    );
}
