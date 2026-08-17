'use client';

import { CircleUser } from 'lucide-react';
import { usd } from '../../lib/seedance/money.mjs';

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
export default function MySpend({ project }) {
    if (!project) return null;
    const mine = Number(project.my_spent_usd ?? 0);
    const total = Number(project.spent_usd ?? 0);
    // Share of the project, for the tooltip only — a percentage in a 60px badge
    // is noise, but it is the first thing you want when the number surprises you.
    const share = total > 0 ? Math.round((mine / total) * 100) : 0;
    const detail = `You have spent ${usd(mine)} on ${project.name}`
        + `${total > 0 ? ` — ${share}% of the project's ${usd(total)}` : ''}`;

    return (
        <output
            aria-label={detail}
            title={detail}
            className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border border-line bg-paper-2 px-2.5 font-mono text-[11px] font-semibold tabular-nums text-ink-2"
        >
            <CircleUser size={13} aria-hidden="true" />
            <span className="hidden sm:inline text-ink-3">You</span>
            <span className="text-ink">{usd(mine)}</span>
        </output>
    );
}
