'use client';

/* Hallmark · page: projects (front door) · genre: modern-minimal · theme: refined-dark-studio
 * pre-emit critique: P5 H5 E4 S4 R5 V4 · contrast: pass · defers to /design.md */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { UserButton } from '@clerk/nextjs';
import { Plus, Users, FolderKanban, ArrowUpRight, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// User-facing project list — the studio's front door. Every generation
// belongs to a project, so spend rolls up per row. Members see only their
// projects; platform admins/org managers see all and can create + manage
// (the server enforces the permission regardless of what we render).

function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function StatusPill({ paused }) {
    return (
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${paused
            ? 'border-warn/25 bg-warn/10 text-warn'
            : 'border-ok/25 bg-ok/10 text-ok'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${paused ? 'bg-warn' : 'bg-ok'}`} />
            {paused ? 'Paused' : 'Active'}
        </span>
    );
}

export default function ProjectsClient() {
    const router = useRouter();
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState('');
    const [saving, setSaving] = useState(false);
    const [confirmingId, setConfirmingId] = useState(null); // project pending archive confirmation
    const [archivingId, setArchivingId] = useState(null);
    const [notice, setNotice] = useState(null); // "request sent" confirmation for members

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
    const canManage = !!data?.canManageProjects; // admin or org manager: create + manage any project
    const items = data?.items ?? [];
    const totalSpend = items.reduce((sum, p) => sum + Number(p.spent_usd ?? 0), 0);

    // Managers create directly; members file a request an admin approves
    // (approval creates the project and adds them to it).
    async function create() {
        const trimmed = name.trim();
        if (!trimmed || saving) return;
        setSaving(true);
        setNotice(null);
        try {
            const url = canManage ? '/api/projects' : '/api/access/request-project';
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: trimmed }),
            });
            const d = await res.json().catch(() => null);
            if (!res.ok) throw new Error(d?.error || d?.message || (canManage ? 'Could not create the project.' : 'Could not send the request.'));
            setName('');
            setCreating(false);
            setError(null);
            if (canManage) load();
            else setNotice(d?.fresh === false
                ? `You already requested “${trimmed}” — waiting for an admin to approve it.`
                : `Request sent — an admin will review “${trimmed}” and you’ll find it here once approved.`);
        } catch (e) {
            setError(e.message);
        } finally {
            setSaving(false);
        }
    }

    // Archive (soft-delete) a project: it drops off the list and can no longer
    // receive generations, but its jobs/billing history stay intact. Admin-only
    // and never the Default project — the server enforces both regardless.
    async function archive(id) {
        setArchivingId(id);
        try {
            const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
            const d = await res.json().catch(() => null);
            if (!res.ok) throw new Error(d?.message || 'Could not archive the project.');
            setConfirmingId(null);
            load();
        } catch (e) {
            setError(e.message);
        } finally {
            setArchivingId(null);
        }
    }

    return (
        <div className="min-h-screen w-full bg-app-bg text-ink">
            <div className="mx-auto max-w-5xl px-5 py-10 sm:px-6 sm:py-14">
                {/* ── Header ── */}
                <header className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                        <div className="mb-2 inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-ink-3">
                            <span className="h-1.5 w-1.5 rounded-full bg-accent" /> loglineAI Studio
                        </div>
                        <h1 className="font-display text-3xl font-semibold leading-none tracking-tight sm:text-4xl">Projects</h1>
                        <p className="mt-2 max-w-md text-sm text-ink-3">
                            Spend, members and model access are scoped per project. Open one to work in the studio.
                        </p>
                    </div>
                    <div className="flex items-center gap-2.5">
                        {data && (
                            <Button
                                type="button"
                                onClick={() => { setNotice(null); setCreating((v) => !v); }}
                                title={canManage ? 'Create a project' : 'Ask an admin to create a project for you'}
                                className="gap-1.5 font-semibold hover:bg-accent-hi"
                            >
                                <Plus size={15} strokeWidth={2.5} /> {canManage ? 'New Project' : 'Request Project'}
                            </Button>
                        )}
                        <div className="rounded-full ring-1 ring-line">
                            <UserButton />
                        </div>
                    </div>
                </header>

                {/* ── Summary strip (all real numbers) ── */}
                {items.length > 0 && (
                    <div className="mt-8 grid grid-cols-3 divide-x divide-line overflow-hidden rounded-lg border border-line bg-paper-1">
                        <Stat label="Projects" value={String(items.length)} />
                        <Stat label="Combined spend" value={`$${totalSpend.toFixed(2)}`} mono />
                        <Stat label="Your role" value={isAdmin ? 'admin' : canManage ? 'manager' : 'member'} accent />
                    </div>
                )}

                {error && (
                    <div className="mt-6 rounded-md border border-danger/25 bg-danger/10 px-4 py-3 text-sm text-danger">
                        {error}
                    </div>
                )}

                {notice && (
                    <div className="mt-6 rounded-md border border-ok/25 bg-ok/10 px-4 py-3 text-sm text-ok">
                        {notice}
                    </div>
                )}

                {creating && (
                    <form
                        onSubmit={(e) => { e.preventDefault(); create(); }}
                        className="mt-6 flex flex-wrap items-center gap-2.5 rounded-lg border border-line bg-paper-1 p-3"
                    >
                        <Input
                            autoFocus
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Project name — e.g. Marketing Videos"
                            className="h-9 min-w-0 flex-1 bg-paper-3"
                        />
                        <Button type="submit" disabled={!name.trim() || saving} className="font-semibold hover:bg-accent-hi">
                            {canManage ? (saving ? 'Creating…' : 'Create') : (saving ? 'Sending…' : 'Send request')}
                        </Button>
                        <Button type="button" variant="outline" onClick={() => { setCreating(false); setName(''); }}>
                            Cancel
                        </Button>
                    </form>
                )}

                {/* ── List ── */}
                <div className="mt-6 overflow-x-auto rounded-lg border border-line bg-paper-1">
                    <table className="w-full min-w-[640px] text-sm">
                        <thead>
                            <tr className="border-b border-line text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">
                                <th className="px-4 py-3">Project</th>
                                <th className="px-4 py-3">Members</th>
                                <th className="px-4 py-3">Status</th>
                                <th className="px-4 py-3">Created</th>
                                <th className="px-4 py-3 text-right">Spent</th>
                                {canManage && <th className="px-4 py-3" />}
                            </tr>
                        </thead>
                        <tbody>
                            {data && !items.length && (
                                <tr>
                                    <td colSpan={canManage ? 6 : 5} className="px-4 py-16 text-center">
                                        <FolderKanban size={26} className="mx-auto text-ink-3" strokeWidth={1.5} />
                                        <p className="mt-3 font-display text-lg text-ink">
                                            {canManage ? 'No projects yet' : 'You’re not in any project yet'}
                                        </p>
                                        <p className="mt-1 text-sm text-ink-3">
                                            {canManage ? 'Create one to start tracking spend and access.' : 'Ask an admin to add you to one, or request a new project above.'}
                                        </p>
                                    </td>
                                </tr>
                            )}
                            {!data && !error && (
                                <tr><td colSpan={canManage ? 6 : 5} className="px-4 py-16 text-center text-sm text-ink-3">Loading projects…</td></tr>
                            )}
                            {items.map((p) => (
                                <tr
                                    key={p.id}
                                    onClick={() => router.push(`/seedance?project=${p.id}`)}
                                    title={`Open the studio in “${p.name}”`}
                                    className="group cursor-pointer border-b border-line/60 transition-colors last:border-0 hover:bg-paper-3"
                                >
                                    <td className="px-4 py-3.5">
                                        <span className="inline-flex items-center gap-2 font-display font-medium text-ink group-hover:text-accent-hi">
                                            {p.name}
                                            <ArrowUpRight size={14} className="text-ink-3 opacity-0 transition-opacity group-hover:opacity-100" />
                                        </span>
                                    </td>
                                    <td className="px-4 py-3.5 text-ink-2">
                                        <span className="inline-flex items-center gap-1.5"><Users size={13} className="text-ink-3" /> {p.member_count ?? 0}</span>
                                    </td>
                                    <td className="px-4 py-3.5"><StatusPill paused={p.paused} /></td>
                                    <td className="px-4 py-3.5 font-mono text-xs text-ink-3">{formatDate(p.created_at)}</td>
                                    <td className="px-4 py-3.5 text-right font-mono text-sm tabular-nums text-ink">
                                        ${Number(p.spent_usd ?? 0).toFixed(2)}
                                    </td>
                                    {canManage && (
                                        <td className="px-4 py-3.5 text-right">
                                            <div className="inline-flex items-center justify-end gap-3" onClick={(e) => e.stopPropagation()}>
                                                <Link
                                                    href={`/console/projects/${p.id}`}
                                                    title="Members, model grants, overrides and budgets"
                                                    className="text-xs font-semibold text-ink-3 transition-colors hover:text-ink"
                                                >
                                                    Manage
                                                </Link>
                                                {isAdmin && p.name !== 'Default' && (
                                                    confirmingId === p.id ? (
                                                        <span className="inline-flex items-center gap-2 text-xs">
                                                            <button
                                                                type="button"
                                                                onClick={() => archive(p.id)}
                                                                disabled={archivingId === p.id}
                                                                className="font-semibold text-danger transition-colors hover:text-danger/80 disabled:opacity-40"
                                                            >
                                                                {archivingId === p.id ? 'Archiving…' : 'Archive?'}
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={() => setConfirmingId(null)}
                                                                className="text-ink-3 transition-colors hover:text-ink"
                                                            >
                                                                Cancel
                                                            </button>
                                                        </span>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            onClick={() => { setError(null); setConfirmingId(p.id); }}
                                                            title="Archive this project (hides it and stops new generations; usage history is kept)"
                                                            className="text-ink-3 transition-colors hover:text-danger"
                                                        >
                                                            <Trash2 size={14} />
                                                        </button>
                                                    )
                                                )}
                                            </div>
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

function Stat({ label, value, mono, accent }) {
    return (
        <div className="px-4 py-3.5">
            <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-3">{label}</div>
            <div className={`mt-1 text-lg font-semibold ${mono ? 'font-mono tabular-nums' : 'font-display'} ${accent ? 'text-accent-hi' : 'text-ink'}`}>
                {value}
            </div>
        </div>
    );
}
