'use client';

/* Honest EXR/upscale progress (see lib/byteplus/exrProgress.mjs): real stage
   + queue position from the server, bar estimated against the median
   duration of past jobs — never a fake percentage. Shared by the EXR tool
   page and the studio's generation viewer; both poll the same status route
   every 5s and hand its `progress` payload here. */

export function fmtDur(ms) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const STAGE_LABELS = { queued: 'Queued', submitting: 'Sending', enhancing: 'Enhancing', done: 'Done' };
const STAGE_ORDER = ['queued', 'submitting', 'enhancing', 'done'];

export default function ExrProgressCard({ progress }) {
    if (!progress) {
        return <p className="text-[11px] leading-relaxed text-ink-3">Generating the 16-bit output — this can take several minutes. Keep this page open.</p>;
    }
    const idx = Math.max(0, STAGE_ORDER.indexOf(progress.stage));
    const pct = Math.round((progress.fraction ?? 0) * 100);
    const detail = progress.stage === 'queued'
        ? (progress.queuePosition != null ? `#${progress.queuePosition} in the queue — starts automatically.` : 'Waiting in the queue…')
        : progress.stage === 'submitting'
            ? 'Sending the clip to the enhancer…'
            : progress.typicalMs
                ? `${fmtDur(progress.elapsedMs)} elapsed · typically ~${fmtDur(progress.typicalMs)}${progress.etaMs != null ? ` · about ${fmtDur(progress.etaMs)} left` : ''}`
                : `${fmtDur(progress.elapsedMs)} elapsed`;
    return (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-paper-2 p-3">
            <div className="flex items-center justify-between">
                {STAGE_ORDER.map((stage, i) => (
                    <span key={stage} className={`text-[11px] font-semibold ${i < idx ? 'text-ink-3' : i === idx ? 'text-accent-hi' : 'text-ink-3/50'}`}>
                        {i < idx ? '✓ ' : ''}{STAGE_LABELS[stage]}
                    </span>
                ))}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-paper-3">
                <div className="h-full rounded-full bg-accent transition-all duration-700" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-[11px] text-ink-3">{detail} Keep this page open.</p>
        </div>
    );
}
