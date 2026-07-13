'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

// User-facing project list — the studio's front door. Every generation
// belongs to a project, so spend rolls up per row. Members see only their
// projects; platform admins see all and can create new ones (the server
// enforces the project.manage permission regardless of what we render).

const BTN = 'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-white/10 bg-white/[0.04] text-white/70 hover:text-white hover:border-white/25 hover:bg-white/[0.08] transition-colors text-xs font-semibold';

function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function ProjectsClient() {
    const router = useRouter();
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState('');
    const [saving, setSaving] = useState(false);

    const load = useCallback(() => {
        fetch('/api/projects')
            .then((r) => r.json().then((d) => ({ ok: r.ok, d })).catch(() => ({ ok: false, d: null })))
            .then(({ ok, d }) => {
                if (!ok) { setError(d?.message || 'Could not load projects.'); return; }
                setError(null);
                setData(d);
            })
            .catch(() => setError('Could not load projects — check your connection.'));
    }, []);
    useEffect(load, [load]);

    const isAdmin = data?.role === 'admin';
    const items = data?.items ?? [];

    async function create() {
        const trimmed = name.trim();
        if (!trimmed || saving) return;
        setSaving(true);
        try {
            const res = await fetch('/api/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: trimmed }),
            });
            const d = await res.json().catch(() => null);
            if (!res.ok) throw new Error(d?.message || 'Could not create the project.');
            setName('');
            setCreating(false);
            load();
        } catch (e) {
            setError(e.message);
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="min-h-screen w-full bg-app-bg text-white">
            <div className="mx-auto max-w-5xl px-6 py-12">
                <div className="flex items-end justify-between gap-4">
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
                        <p className="mt-1 text-sm text-white/40">
                            {items.length} project{items.length === 1 ? '' : 's'} — spend, members and model access are scoped per project.
                        </p>
                    </div>
                    <div className="flex items-center gap-2.5">
                        {isAdmin && (
                            <button type="button" onClick={() => setCreating((v) => !v)} className={BTN}>
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                                <span>New Project</span>
                            </button>
                        )}
                    </div>
                </div>

                {error && (
                    <div className="mt-6 rounded-md border border-rose-400/25 bg-rose-400/[0.08] px-4 py-3 text-sm text-rose-200">
                        {error}
                    </div>
                )}

                {creating && (
                    <form
                        onSubmit={(e) => { e.preventDefault(); create(); }}
                        className="mt-6 flex items-center gap-2.5 rounded-lg border border-white/10 bg-white/[0.03] p-3"
                    >
                        <input
                            autoFocus
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Project name — e.g. Marketing Videos"
                            className="flex-1 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/25 focus:border-white/30 focus:outline-none"
                        />
                        <button type="submit" disabled={!name.trim() || saving} className={`${BTN} disabled:opacity-40`}>
                            {saving ? 'Creating…' : 'Create'}
                        </button>
                        <button type="button" onClick={() => { setCreating(false); setName(''); }} className={BTN}>Cancel</button>
                    </form>
                )}

                <div className="mt-6 overflow-x-auto rounded-lg border border-white/10">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-[11px] uppercase tracking-wider text-white/35">
                                <th className="px-4 py-3 font-semibold">Project Name</th>
                                <th className="px-4 py-3 font-semibold">Members</th>
                                <th className="px-4 py-3 font-semibold">Your Role</th>
                                <th className="px-4 py-3 font-semibold">Status</th>
                                <th className="px-4 py-3 font-semibold">Created</th>
                                <th className="px-4 py-3 text-right font-semibold">Spent</th>
                                {isAdmin && <th className="px-4 py-3" />}
                            </tr>
                        </thead>
                        <tbody>
                            {data && !items.length && (
                                <tr>
                                    <td colSpan={isAdmin ? 7 : 6} className="px-4 py-12 text-center text-sm text-white/35">
                                        {isAdmin
                                            ? 'No projects yet — create one to get started.'
                                            : 'You are not in any project yet — ask an admin to add you.'}
                                    </td>
                                </tr>
                            )}
                            {!data && !error && (
                                <tr><td colSpan={isAdmin ? 7 : 6} className="px-4 py-12 text-center text-sm text-white/35">Loading projects…</td></tr>
                            )}
                            {items.map((p) => (
                                <tr
                                    key={p.id}
                                    onClick={() => router.push(`/seedance?project=${p.id}`)}
                                    title={`Open the studio in “${p.name}”`}
                                    className="cursor-pointer border-t border-white/5 transition-colors hover:bg-white/[0.04]"
                                >
                                    <td className="px-4 py-3 font-semibold text-white/85">{p.name}</td>
                                    <td className="px-4 py-3 text-white/50">{p.member_count ?? 0}</td>
                                    <td className="px-4 py-3">
                                        <span className="rounded border border-sky-400/25 bg-sky-400/[0.08] px-1.5 py-0.5 text-[11px] font-semibold text-sky-300/90">
                                            {p.my_role || (isAdmin ? 'admin' : 'member')}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3">
                                        {p.paused
                                            ? <span className="rounded border border-amber-400/25 bg-amber-400/[0.08] px-1.5 py-0.5 text-[11px] font-semibold text-amber-300/90">paused</span>
                                            : <span className="rounded border border-emerald-400/25 bg-emerald-400/[0.08] px-1.5 py-0.5 text-[11px] font-semibold text-emerald-300/90">active</span>}
                                    </td>
                                    <td className="px-4 py-3 text-white/50">{formatDate(p.created_at)}</td>
                                    <td className="px-4 py-3 text-right font-semibold tabular-nums text-white/80">
                                        ${Number(p.spent_usd ?? 0).toFixed(2)}
                                    </td>
                                    {isAdmin && (
                                        <td className="px-4 py-3 text-right">
                                            <Link
                                                href={`/console/projects/${p.id}`}
                                                onClick={(e) => e.stopPropagation()}
                                                title="Members, model grants, overrides and budgets"
                                                className="text-xs font-semibold text-white/40 hover:text-white"
                                            >
                                                Manage
                                            </Link>
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
