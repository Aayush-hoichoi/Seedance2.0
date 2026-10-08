'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { usd } from '../../lib/seedance/money.mjs';

// The bottom-left profile button + panel: everything about the signed-in
// user ACROSS workspaces (memberships, spend per project, per model, and the
// per-project-per-model breakdown, plus personal budget caps). Same for
// admins — this is always the viewer's own profile. All rollups derive from
// the one (project × model) matrix the API returns, so every subtotal
// reconciles with every other by construction.

const rollup = (rows, key, label) => {
    const out = new Map();
    for (const r of rows) {
        const k = r[key] ?? '—';
        const cur = out.get(k) ?? { id: k, name: r[label] ?? '—', spent: 0, gens: 0, month: 0, rows: [] };
        cur.spent += r.spent_usd; cur.gens += r.generations; cur.month += r.month_usd; cur.rows.push(r);
        out.set(k, cur);
    }
    return [...out.values()].sort((a, b) => b.spent - a.spent);
};

function Bar({ value, max }) {
    return (
        <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-paper-3">
            <div className="h-full rounded-full bg-accent" style={{ width: `${max > 0 ? Math.max(3, Math.round((value / max) * 100)) : 0}%` }} />
        </div>
    );
}

function Stat({ label, value }) {
    return (
        <div className="rounded-lg border border-line bg-paper-2 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{label}</div>
            <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-ink">{value}</div>
        </div>
    );
}

export default function UserProfile() {
    const [open, setOpen] = useState(false);
    const [data, setData] = useState(null);
    useEffect(() => {
        if (!open || data) return undefined;
        let alive = true;
        fetch('/api/me/profile')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (alive) setData(d ?? { error: true }); })
            .catch(() => { if (alive) setData({ error: true }); });
        return () => { alive = false; };
    }, [open, data]);

    const u = data?.user;
    const initial = (u?.name || u?.email || '?').trim().charAt(0).toUpperCase();
    const spendRows = data?.spend ?? [];
    const byProject = rollup(spendRows, 'project_id', 'project_name');
    const byModel = rollup(spendRows, 'model_id', 'model_name');
    const totalSpent = spendRows.reduce((s, r) => s + r.spent_usd, 0);
    const monthSpent = spendRows.reduce((s, r) => s + r.month_usd, 0);
    const totalGens = spendRows.reduce((s, r) => s + r.generations, 0);
    const topProject = byProject[0]?.spent ?? 0;
    const topModel = byModel[0]?.spent ?? 0;

    return (
        <>
            <button data-liquid-glass=""
                type="button"
                onClick={() => setOpen(true)}
                title="Your profile — projects, spend and budgets across every workspace"
                aria-label="Open your profile"
                className="fixed bottom-3 left-3 z-40 grid h-9 w-9 place-items-center rounded-full border border-white/15 bg-black/60 font-display text-sm font-bold text-white/80 shadow-2xl backdrop-blur-sm transition-colors hover:border-primary/50 hover:text-primary"
            >
                {data ? initial : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" /></svg>}
            </button>
            {open && createPortal(
                <div className="fixed inset-0 z-[70] flex items-end justify-start bg-black/60 p-3 sm:items-center sm:justify-center" onClick={() => setOpen(false)}>
                    <div
                        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-paper-1 shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {!data || data.error ? (
                            <div className="flex items-center gap-2 p-6 text-sm text-ink-3">
                                {data?.error ? 'Could not load your profile — try again.' : (<><Loader2 size={14} className="animate-spin" /> Loading your profile…</>)}
                            </div>
                        ) : (
                            <>
                                <div className="flex items-center gap-3 border-b border-line px-4 py-3">
                                    <span className="grid h-10 w-10 place-items-center rounded-full bg-accent font-display text-base font-bold text-accent-ink">{initial}</span>
                                    <div className="min-w-0 flex-1 leading-tight">
                                        <div className="truncate text-sm font-semibold text-ink">{u.name || u.email || 'You'}</div>
                                        <div className="truncate text-[11px] text-ink-3">
                                            {u.email}
                                            {u.createdAt && ` · member since ${new Date(u.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`}
                                        </div>
                                    </div>
                                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${u.role === 'admin' ? 'bg-accent/15 text-accent-hi' : 'bg-paper-3 text-ink-3'}`}>{u.role || 'member'}</span>
                                    <button data-liquid-glass="" type="button" onClick={() => setOpen(false)} aria-label="Close" className="shrink-0 rounded-md p-1.5 text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink">
                                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                                    </button>
                                </div>

                                <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-4 py-3">
                                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                        <Stat label="Total spent" value={usd(totalSpent)} />
                                        <Stat label="This month" value={usd(monthSpent)} />
                                        <Stat label="Projects" value={data.memberships.length} />
                                        <Stat label="Generations" value={totalGens} />
                                    </div>

                                    <div className="mt-4 mb-2 text-[10px] font-bold uppercase tracking-wider text-ink-3">Spend by project</div>
                                    {byProject.length === 0 && <p className="text-xs text-ink-3">No spend recorded yet.</p>}
                                    <div className="space-y-1">
                                        {byProject.map((p) => (
                                            <details key={p.id} className="group rounded-lg border border-line bg-paper-2">
                                                <summary className="cursor-pointer list-none px-3 py-2 text-xs [&::-webkit-details-marker]:hidden">
                                                    <div className="flex items-baseline justify-between gap-2">
                                                        <span className="min-w-0 truncate font-medium text-ink-2">{p.name}</span>
                                                        <span className="shrink-0 font-mono tabular-nums text-ink">{usd(p.spent)}</span>
                                                    </div>
                                                    <div className="mt-1 flex items-center gap-2">
                                                        <Bar value={p.spent} max={topProject} />
                                                        <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-3">{p.gens}×</span>
                                                        <span className="shrink-0 text-[10px] text-ink-3 transition-transform group-open:rotate-180">▾</span>
                                                    </div>
                                                </summary>
                                                {/* Per-model rows inside this project — the full breakdown. */}
                                                <ul className="space-y-1 border-t border-line px-3 py-2">
                                                    {[...p.rows].sort((a, b) => b.spent_usd - a.spent_usd).map((r) => (
                                                        <li key={`${p.id}:${r.model_id}`} className="flex items-baseline justify-between gap-2 text-[11px]">
                                                            <span className="min-w-0 truncate text-ink-3">{r.model_name}</span>
                                                            <span className="shrink-0 font-mono tabular-nums text-ink-2">{usd(r.spent_usd)} <span className="text-ink-3">· {r.generations}×</span></span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </details>
                                        ))}
                                    </div>

                                    <div className="mt-4 mb-2 text-[10px] font-bold uppercase tracking-wider text-ink-3">Spend by model — all workspaces</div>
                                    <ul className="space-y-1.5">
                                        {byModel.map((m) => (
                                            <li key={m.id} className="text-xs">
                                                <div className="flex items-baseline justify-between gap-2">
                                                    <span className="min-w-0 truncate text-ink-2">{m.name}</span>
                                                    <span className="shrink-0 font-mono tabular-nums text-ink">{usd(m.spent)}</span>
                                                </div>
                                                <div className="mt-0.5 flex items-center gap-2">
                                                    <Bar value={m.spent} max={topModel} />
                                                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-3">{m.gens}×</span>
                                                </div>
                                            </li>
                                        ))}
                                    </ul>

                                    {data.memberships.length > 0 && (
                                        <>
                                            <div className="mt-4 mb-2 text-[10px] font-bold uppercase tracking-wider text-ink-3">Member of</div>
                                            <div className="flex flex-wrap gap-1.5 pb-2">
                                                {data.memberships.map((m) => (
                                                    <span key={m.id} className="rounded-full border border-line bg-paper-2 px-2.5 py-1 text-[11px] text-ink-2">
                                                        {m.name} <span className="text-ink-3">· {m.member_count} member{m.member_count === 1 ? '' : 's'}</span>
                                                    </span>
                                                ))}
                                            </div>
                                        </>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                </div>,
                document.body,
            )}
        </>
    );
}
