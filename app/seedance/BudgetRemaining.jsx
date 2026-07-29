'use client';

/* Hallmark · pre-emit critique: P5 H4 E5 S5 R5 V4 */

import { useEffect, useState } from 'react';
import { WalletCards } from 'lucide-react';

const money = (value) => `$${Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
})}`;

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

    const ratio = budget.limit > 0 ? budget.remaining / budget.limit : 0;
    const tone = ratio <= 0.05 ? 'border-danger/40 text-danger' : ratio <= 0.15 ? 'border-warn/40 text-warn' : 'border-line text-ink-2';
    const reset = budget.resetsAt
        ? new Date(budget.resetsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : null;
    const detail = `${budget.scope}: ${money(budget.remaining)} remaining of ${money(budget.limit)}`
        + `${budget.reserved > 0 ? ` (${money(budget.reserved)} in flight)` : ''}`
        + `${reset ? ` · resets ${reset}` : ''}`;

    return (
        <output
            aria-label={detail}
            title={detail}
            className={`fixed left-3 top-12 z-40 inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border bg-paper-2 px-2.5 font-mono text-[11px] font-semibold tabular-nums sm:static ${tone}`}
        >
            <WalletCards size={13} aria-hidden="true" />
            <span className="hidden sm:inline">Budget</span>
            <span className="text-ink">{money(budget.remaining)}</span>
            <span className="text-ink-3">left</span>
        </output>
    );
}
