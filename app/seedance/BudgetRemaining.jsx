'use client';

/* Hallmark · pre-emit critique: P5 H4 E5 S5 R5 V4 */

import { useEffect, useState } from 'react';
import { WalletCards } from 'lucide-react';
import { usd as money } from '../../lib/seedance/money.mjs';

export default function BudgetRemaining({ projectId, modelId, refreshKey = 0 }) {
    const [budget, setBudget] = useState(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!projectId) return;
        let alive = true;
        const controller = new AbortController();

        async function load() {
            setLoading(true);
            try {
                const query = new URLSearchParams({ projectId: String(projectId) });
                if (modelId) query.set('modelId', modelId);
                const response = await fetch(`/api/budgets/me?${query}`, {
                    signal: controller.signal,
                    cache: 'no-store',
                });
                const data = response.ok ? await response.json() : null;
                if (alive) setBudget(data?.budget ?? null);
            } catch {
                // Budget visibility is helpful, but must never block the studio.
            } finally {
                if (alive) setLoading(false);
            }
        }

        load();
        const timer = setInterval(load, 30_000);
        return () => {
            alive = false;
            controller.abort();
            clearInterval(timer);
        };
    }, [projectId, modelId, refreshKey]);

    if (!budget && !loading) return null;
    if (!budget) {
        return <div aria-label="Loading budget" className="fixed left-3 top-12 z-40 h-7 w-24 animate-pulse rounded-md border border-line bg-paper-2 sm:static" />;
    }

    // The headline number deducts only SETTLED spend — money held for a
    // still-rendering generation stays in "left" and shows as "in flight"
    // instead, so a failed render never reads as a charge. The warning tone
    // still tracks what is spendable RIGHT NOW (holds included), since that is
    // what decides whether the next Generate will be accepted.
    const available = Math.max(0, budget.limit - budget.used);
    const inFlight = budget.reserved > 0 ? budget.reserved : 0;
    const ratio = budget.limit > 0 ? budget.remaining / budget.limit : 0;
    const tone = ratio <= 0.05 ? 'border-danger/40 text-danger' : ratio <= 0.15 ? 'border-warn/40 text-warn' : 'border-line text-ink-2';
    const reset = budget.resetsAt
        ? new Date(budget.resetsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : null;
    const detail = `${budget.scope}: ${money(available)} remaining of ${money(budget.limit)}`
        + `${inFlight ? ` — ${money(inFlight)} of it held for generations still rendering (released if they fail)` : ''}`
        + `${reset ? ` · resets ${reset}` : ''}`;

    return (
        <output
            aria-label={detail}
            title={detail}
            className={`fixed left-3 top-12 z-40 inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border bg-paper-2 px-2.5 font-mono text-[11px] font-semibold tabular-nums sm:static ${tone}`}
        >
            <WalletCards size={13} aria-hidden="true" />
            <span className="hidden sm:inline">{budget.scope}</span>
            <span className="text-ink">{money(available)}</span>
            <span className="text-ink-3">left</span>
            {inFlight > 0 && (
                <span className="inline-flex items-baseline gap-1 border-l border-line-strong pl-1.5 text-ink-3">
                    <span className="text-ink-2">{money(inFlight)}</span>
                    <span className="hidden md:inline">in flight</span>
                </span>
            )}
        </output>
    );
}
