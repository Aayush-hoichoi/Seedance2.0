'use client';

import { useEffect, useRef } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import { usd } from '../../../lib/seedance/money.mjs';

const POLL_MS = 10_000;
const ACTIVE = new Set(['queued', 'processing']);

// Per-browser list of this viewer's upscale jobs. The server row is the truth
// (the worker finishes jobs with the tab closed); this only remembers which
// task tokens to poll, so a reload resumes watching.
const STORE_KEY = 'll_upscale_jobs_v1';
export function loadUpscaleJobs() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]').slice(0, 30); } catch { return []; }
}
export function saveUpscaleJobs(jobs) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(jobs.slice(0, 30))); } catch { /* private window: in-memory only */ }
}

export default function UpscaleJobs({ jobs, onPatch, onRemove }) {
    const patchRef = useRef(onPatch);
    patchRef.current = onPatch;
    const activeKey = jobs.filter((j) => ACTIVE.has(j.status)).map((j) => j.token).join('|');

    useEffect(() => {
        if (!activeKey) return undefined;
        let alive = true;
        const tick = async () => {
            for (const token of activeKey.split('|')) {
                try {
                    const r = await fetch(`/api/seedance/upscale?task=${encodeURIComponent(token)}`);
                    const d = await r.json().catch(() => null);
                    if (!alive) return;
                    if (!r.ok) {
                        // 4xx is final (token revoked / access removed); 5xx retries next tick.
                        if (r.status < 500) patchRef.current(token, { status: 'failed', error: d?.error || `Status check failed (${r.status}).` });
                        continue;
                    }
                    patchRef.current(token, { status: d.status, url: d.url || null, error: d.error || null, durable: !!d.durable, output: d.metadata || null });
                } catch { /* offline — next tick */ }
            }
        };
        tick();
        const id = setInterval(tick, POLL_MS);
        return () => { alive = false; clearInterval(id); };
    }, [activeKey]);

    if (!jobs.length) return null;
    return (
        <section className="mt-8">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-3">Your upscales</h2>
            <div className="flex flex-col gap-2">
                {jobs.map((j) => <JobRow key={j.token} job={j} onRemove={() => onRemove(j.token)} />)}
            </div>
        </section>
    );
}

function JobRow({ job: j, onRemove }) {
    const active = ACTIVE.has(j.status);
    return (
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-paper-2 p-3 sm:flex-row sm:items-center">
            {j.status === 'succeeded' && j.url && j.container === 'mp4'
                ? <video src={j.url} controls muted playsInline className="aspect-video w-full rounded-md bg-black sm:w-56" />
                : null}
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{j.name || 'Video'}</div>
                <div className="mt-0.5 text-[11px] text-ink-3">
                    {j.summary}{j.estimate != null ? ` · est. ${usd(j.estimate)}` : ''} · .{j.container}
                </div>
                {j.status === 'failed' || j.status === 'cancelled'
                    ? <div className="mt-1 text-xs text-danger">{j.error || `Upscale ${j.status}.`}</div>
                    : null}
                {j.status === 'succeeded' && j.output ? (
                    <div className="mt-1 font-mono text-[11px] text-ok">
                        Output: {[j.output.resolution, j.output.fps && `${Number(j.output.fps).toFixed(2).replace(/\.?0+$/, '')} fps`, j.output.duration && `${Number(j.output.duration).toFixed(1)}s`].filter(Boolean).join(' · ')}
                    </div>
                ) : null}
                {j.status === 'succeeded' && !j.durable
                    ? <div className="mt-1 text-[11px] text-warn">Temporary link from BytePlus — download within 24h.</div>
                    : null}
            </div>
            <div className="flex items-center gap-2">
                {active && (
                    <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
                        <Loader2 size={13} className="animate-spin" /> {j.status === 'queued' ? 'Queued' : 'Upscaling'}
                        {j.waitMin ? <span className="text-ink-3">· ~{j.waitMin} min</span> : null}
                    </span>
                )}
                {j.status === 'succeeded' && j.url && (
                    <a href={j.url} target="_blank" rel="noreferrer" download
                        className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-ink hover:opacity-90">
                        <Download size={13} /> Download
                    </a>
                )}
                {!active && (
                    <button type="button" onClick={onRemove} title="Remove from list" aria-label="Remove from list"
                        className="grid h-7 w-7 place-items-center rounded-md text-ink-3 hover:bg-paper-3 hover:text-ink">
                        <X size={14} />
                    </button>
                )}
            </div>
        </div>
    );
}
