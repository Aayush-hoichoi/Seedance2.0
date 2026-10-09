'use client';

import { CONTROL } from '@/components/ui/surface-styles';

import { useEffect, useRef, useState } from 'react';
import { CircleUser, Loader2 } from 'lucide-react';
import { usd } from '../../lib/seedance/money.mjs';
import { normalizeSpendRank } from '../../lib/seedance/spendRank.mjs';

// What the signed-in user has spent on the CURRENT project — the personal
// counterpart to the project total on the chip at the other end of the header.
//
// Both numbers come from the same /api/projects row (spent_usd / my_spent_usd),
// same event types, same all-time window, so "yours" can never exceed "the
// project's" and the pair always reconciles. Sourcing them separately is what
// would make that possible.
//
// Hovering (or tapping) the chip opens the model-wise breakdown of that same
// spend, fetched lazily from /api/usage/me — same window, same event types,
// so the rows always sum to the number on the chip.
//
// Distinct from BudgetRemaining beside it: that one counts DOWN what is left of
// a cap and disappears when no cap is set. This always shows, cap or not.
export default function MySpend({ project, spendRank }) {
    const [open, setOpen] = useState(false);
    const [breakdown, setBreakdown] = useState(null); // null = not loaded, [] = loaded empty
    const closeTimer = useRef(null);
    // A project switch invalidates the loaded rows.
    useEffect(() => { setBreakdown(null); setOpen(false); }, [project?.id]);
    useEffect(() => () => clearTimeout(closeTimer.current), []);
    if (!project) return null;
    const mine = Number(project.my_spent_usd ?? 0);
    const total = Number(project.spent_usd ?? 0);
    const leaderboard = normalizeSpendRank(spendRank);
    // Share of the project, for the tooltip only — a percentage in a 60px badge
    // is noise, but it is the first thing you want when the number surprises you.
    const share = total > 0 ? Math.round((mine / total) * 100) : 0;
    const detail = `You have spent ${usd(mine)} on ${project.name}`
        + `${total > 0 ? ` — ${share}% of the project's ${usd(total)}` : ''}`
        + `${leaderboard ? `. Your workspace spending rank this month is ${leaderboard.detail}` : ''}`;

    const show = () => {
        clearTimeout(closeTimer.current);
        setOpen(true);
        if (breakdown === null) {
            fetch(`/api/usage/me?projectId=${project.id}`)
                .then((r) => (r.ok ? r.json() : null))
                .then((d) => setBreakdown(Array.isArray(d?.items) ? d.items : []))
                .catch(() => setBreakdown([]));
        }
    };
    // A grace period so the pointer can travel from chip to popover.
    const hide = () => { closeTimer.current = setTimeout(() => setOpen(false), 150); };
    const top = breakdown?.length ? Math.max(...breakdown.map((r) => r.spent_usd)) : 0;

    // Below sm the top bar has no room for this, so it drops to its own row
    // under the bar — the same treatment BudgetRemaining gets.
    return (
        <div
            // Mobile keeps the chip's original fixed slot under the bar; from
            // sm it must be BOTH inline (so the header row lines up exactly as
            // when <output> carried the classes itself) and relative with the
            // offsets reset (right-3/top-12 would otherwise shift a relative
            // element), so the breakdown popover anchors to the chip.
            className="fixed right-3 top-12 z-40 inline-flex sm:relative sm:right-auto sm:top-auto"
            onMouseEnter={show}
            onMouseLeave={hide}
        >
            <output
                aria-label={detail}
                onClick={() => (open ? setOpen(false) : show())}
                className={`${CONTROL} inline-flex h-7 cursor-default items-center whitespace-nowrap px-2.5 font-mono text-[11px] font-semibold tabular-nums`}
            >
                <span className="inline-flex items-center gap-1.5">
                    <CircleUser size={13} aria-hidden="true" />
                    <span className="hidden sm:inline text-ink-3">You</span>
                </span>
                {leaderboard && (
                    <span
                        className="ml-1.5 inline-flex items-baseline gap-1 border-l border-line-strong pl-1.5"
                        title={`Workspace spending rank this month: ${leaderboard.detail}`}
                    >
                        <span className="font-sans text-[9px] font-medium uppercase tracking-[0.08em] text-ink-3">Rank</span>
                        <span className="text-accent-hi">{leaderboard.label}</span>
                        {leaderboard.userCount && (
                            <span className="hidden text-ink-3 md:inline">of {leaderboard.userCount}</span>
                        )}
                    </span>
                )}
                <span className="ml-1.5 inline-flex items-baseline gap-1 border-l border-line-strong pl-1.5">
                    <span className="text-ink">{usd(mine)}</span>
                    <span className="hidden font-sans text-[9px] font-medium uppercase tracking-[0.08em] text-ink-3 lg:inline">
                        spent
                    </span>
                </span>
            </output>
            {open && (
                <div className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded-lg border border-line bg-paper-1 p-3 shadow-2xl">
                    <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-ink-3">
                        Your spend on {project.name} · by model
                    </div>
                    {breakdown === null ? (
                        <div className="flex items-center gap-2 py-1 text-[11px] text-ink-3"><Loader2 size={12} className="animate-spin" /> Loading…</div>
                    ) : breakdown.length === 0 ? (
                        <p className="py-1 text-[11px] text-ink-3">No spend recorded on this workspace yet.</p>
                    ) : (
                        <ul className="space-y-1.5">
                            {breakdown.map((r) => (
                                <li key={r.model_id ?? 'unknown'} className="text-[11px]">
                                    <div className="flex items-baseline justify-between gap-2">
                                        <span className="min-w-0 truncate text-ink-2">{r.model_name}</span>
                                        <span className="shrink-0 font-mono tabular-nums text-ink">{usd(r.spent_usd)}</span>
                                    </div>
                                    <div className="mt-0.5 flex items-center gap-2">
                                        <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-paper-3">
                                            <div className="h-full rounded-full bg-accent" style={{ width: `${top > 0 ? Math.max(3, Math.round((r.spent_usd / top) * 100)) : 0}%` }} />
                                        </div>
                                        <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-3">{r.generations}×</span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                    {breakdown?.length > 0 && (
                        <div className="mt-2 flex items-baseline justify-between border-t border-line pt-2 text-[11px]">
                            <span className="text-ink-3">Total</span>
                            <span className="font-mono font-semibold tabular-nums text-ink">{usd(mine)}</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
