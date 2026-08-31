'use client';

import { CircleUser } from 'lucide-react';
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
// Distinct from BudgetRemaining beside it: that one counts DOWN what is left of
// a cap and disappears when no cap is set. This always shows, cap or not.
export default function MySpend({ project, spendRank }) {
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

    // Below sm the top bar has no room for this, so it drops to its own row
    // under the bar — the same treatment BudgetRemaining gets.
    return (
        <output
            aria-label={detail}
            title={detail}
            className="fixed right-3 top-12 z-40 inline-flex h-7 items-center whitespace-nowrap rounded-md border border-line bg-paper-2 px-2.5 font-mono text-[11px] font-semibold tabular-nums text-ink-2 sm:static"
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
    );
}
