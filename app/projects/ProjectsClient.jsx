'use client';

/* Hallmark · page: projects (front door) · genre: modern-minimal · theme: refined-dark-studio
 * pre-emit critique: P5 H5 E5 S4 R5 V5 · contrast: pass · defers to /design.md
 * v2: nav rail + card grid; create/request and archive live in dialogs. */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { UserButton } from '@clerk/nextjs';
import { Plus, Users, FolderKanban, ArrowUpRight, Trash2, Search, Clock, Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import ProjectsSidebar from './ProjectsSidebar.jsx';
import WelcomeSplash from './WelcomeSplash.jsx';

// User-facing project list — the studio's front door. Every generation belongs
// to a project, so spend rolls up per card. Members see only their projects
// (and may REQUEST new ones); platform admins/org managers see all and create
// directly (the server enforces permissions regardless of what we render).

function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function StatusPill({ paused }) {
    return (
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${paused
            ? 'border-warn/25 bg-warn/10 text-warn'
            : 'border-ok/25 bg-ok/10 text-ok'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${paused ? 'bg-warn' : 'bg-ok'}`} />
            {paused ? 'Paused' : 'Active'}
        </span>
    );
}

function Stat({ label, value, mono, accent }) {
    return (
        <div className="rounded-lg border border-line bg-paper-1 px-4 py-3.5">
            <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-3">{label}</div>
            <div className={`mt-1 text-lg font-semibold ${mono ? 'font-mono tabular-nums' : 'font-display'} ${accent ? 'text-accent-hi' : 'text-ink'}`}>
                {value}
            </div>
        </div>
    );
}

function ProjectCard({ p, canManage, isAdmin, onOpen, onArchive }) {
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onOpen}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
            title={`Open the studio in “${p.name}”`}
            className="group flex cursor-pointer flex-col rounded-xl border border-line bg-paper-1 p-4 transition-all hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-display text-base font-semibold text-ink transition-colors group-hover:text-accent-hi">
                        <span className="truncate">{p.name}</span>
                        <ArrowUpRight size={14} className="shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100" />
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-ink-3">
                        <span className="inline-flex items-center gap-1"><Users size={12} /> {p.member_count ?? 0}</span>
                        <span className="inline-flex items-center gap-1"><Clock size={12} /> {formatDate(p.created_at)}</span>
                    </div>
                </div>
                <StatusPill paused={p.paused} />
            </div>

            <div className="mt-4 flex items-end justify-between border-t border-line/60 pt-3">
                <div>
                    <div className="text-[10px] uppercase tracking-wider text-ink-3">Spent</div>
                    <div className="font-mono text-sm font-semibold tabular-nums text-ink">${Number(p.spent_usd ?? 0).toFixed(2)}</div>
                </div>
                {canManage && (
                    <div className="flex items-center gap-2.5 opacity-0 transition-opacity group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                        <Link
                            href={`/console/projects/${p.id}`}
                            title="Members, model grants, overrides and budgets"
                            className="text-xs font-semibold text-ink-3 transition-colors hover:text-ink"
                        >
                            Manage
                        </Link>
                        {isAdmin && p.name !== 'Default' && (
                            <button
                                type="button"
                                onClick={onArchive}
                                title="Archive this project (hides it and stops new generations; usage history is kept)"
                                className="text-ink-3 transition-colors hover:text-danger"
                            >
                                <Trash2 size={14} />
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

export default function ProjectsClient() {
    const router = useRouter();
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null); // "request sent" confirmation for members
    const [railCollapsed, setRailCollapsed] = useState(false); // left nav rail (desktop)
    const [railOpen, setRailOpen] = useState(false); // same rail as an off-canvas drawer (mobile)
    const [createOpen, setCreateOpen] = useState(false);
    const [name, setName] = useState('');
    const [saving, setSaving] = useState(false);
    const [toArchive, setToArchive] = useState(null); // project pending archive confirmation
    const [archiving, setArchiving] = useState(false);
    const [query, setQuery] = useState('');

    useEffect(() => {
        if (!railOpen) return undefined;
        const closeOnEscape = (event) => { if (event.key === 'Escape') setRailOpen(false); };
        window.addEventListener('keydown', closeOnEscape);
        return () => window.removeEventListener('keydown', closeOnEscape);
    }, [railOpen]);

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
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        return q ? items.filter((p) => p.name.toLowerCase().includes(q)) : items;
    }, [items, query]);

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
            setCreateOpen(false);
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

    // Archive (soft-delete): drops off the list and stops new generations, but
    // jobs/billing history stay intact. Admin-only; never the Default project.
    async function archive() {
        if (!toArchive) return;
        setArchiving(true);
        try {
            const res = await fetch(`/api/projects/${toArchive.id}`, { method: 'DELETE' });
            const d = await res.json().catch(() => null);
            if (!res.ok) throw new Error(d?.message || 'Could not archive the project.');
            setToArchive(null);
            load();
        } catch (e) {
            setError(e.message);
        } finally {
            setArchiving(false);
        }
    }

    return (
        <div className="min-h-screen w-full bg-app-bg text-ink">
            <WelcomeSplash />
            <ProjectsSidebar
                isAdmin={isAdmin}
                collapsed={railCollapsed}
                onToggle={() => setRailCollapsed((v) => !v)}
                open={railOpen}
                onClose={() => setRailOpen(false)}
            />
            <div className={railCollapsed ? 'sm:pl-14' : 'sm:pl-56'}>
                <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
                    {/* ── Header ── */}
                    <header className="flex flex-wrap items-start justify-between gap-4">
                        <div className="min-w-0">
                            <div className="mb-2 inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-ink-3">
                                <button type="button" onClick={() => setRailOpen(true)} aria-label="Open menu"
                                    aria-controls="projects-navigation" aria-expanded={railOpen}
                                    className="-ml-1 rounded-md p-1 text-ink-2 hover:bg-paper-2 sm:hidden">
                                    <Menu size={16} />
                                </button>
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
                                    onClick={() => { setNotice(null); setCreateOpen(true); }}
                                    title={canManage ? 'Create a project' : 'Ask an admin to create a project for you'}
                                    className="gap-1.5 font-semibold hover:bg-accent-hi"
                                >
                                    <Plus size={15} strokeWidth={2.5} /> {canManage ? 'New Project' : 'Request Project'}
                                </Button>
                            )}
                            <div className="rounded-full ring-1 ring-line sm:hidden">
                                <UserButton />
                            </div>
                        </div>
                    </header>

                    {/* ── Summary strip (all real numbers) ── */}
                    {items.length > 0 && (
                        <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
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

                    {/* ── Search (only once it earns its place) ── */}
                    {items.length > 6 && (
                        <div className="relative mt-6 w-72 max-w-full">
                            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 z-10 -translate-y-1/2 text-ink-3" />
                            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a project…"
                                className="h-9 bg-paper-1 pl-8" />
                        </div>
                    )}

                    {/* ── Grid ── */}
                    <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {!data && !error && [...Array(6)].map((_, i) => (
                            <div key={i} className="h-36 animate-pulse rounded-xl border border-line bg-paper-1" />
                        ))}
                        {shown.map((p) => (
                            <ProjectCard
                                key={p.id}
                                p={p}
                                canManage={canManage}
                                isAdmin={isAdmin}
                                onOpen={() => router.push(`/seedance?project=${p.id}`)}
                                onArchive={() => { setError(null); setToArchive(p); }}
                            />
                        ))}
                    </div>

                    {data && !items.length && (
                        <div className="mt-6 flex flex-col items-center rounded-xl border border-dashed border-line py-16 text-center">
                            <FolderKanban size={26} className="text-ink-3" strokeWidth={1.5} />
                            <p className="mt-3 font-display text-lg text-ink">
                                {canManage ? 'No projects yet' : 'You’re not in any project yet'}
                            </p>
                            <p className="mt-1 max-w-xs text-sm text-ink-3">
                                {canManage ? 'Create one to start tracking spend and access.' : 'Ask an admin to add you to one, or request your own.'}
                            </p>
                            <Button className="mt-4 gap-1.5 font-semibold hover:bg-accent-hi" onClick={() => setCreateOpen(true)}>
                                <Plus size={15} strokeWidth={2.5} /> {canManage ? 'New Project' : 'Request Project'}
                            </Button>
                        </div>
                    )}

                    {data && items.length > 0 && !shown.length && (
                        <p className="mt-6 text-center text-sm text-ink-3">No project matches “{query}”.</p>
                    )}
                </div>
            </div>

            {/* ── Create / request dialog ── */}
            <Dialog open={createOpen} onOpenChange={(v) => { setCreateOpen(v); if (!v) setName(''); }}>
                <DialogContent className="w-[min(92vw,440px)] rounded-xl border-line bg-paper-1 p-5">
                    <DialogHeader>
                        <DialogTitle className="font-display text-base font-semibold text-ink">
                            {canManage ? 'Create project' : 'Request a project'}
                        </DialogTitle>
                        <DialogDescription className="text-xs text-ink-3">
                            {canManage
                                ? 'Members, model access and budgets are managed per project after creation.'
                                : 'An admin reviews the request; once approved, the project appears here with you in it.'}
                        </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={(e) => { e.preventDefault(); create(); }}>
                        <Input
                            autoFocus
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Project name — e.g. Marketing Videos"
                            className="h-9 bg-paper-3"
                        />
                        <DialogFooter className="mt-4 gap-2 sm:gap-2">
                            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
                            <Button type="submit" disabled={!name.trim() || saving} className="font-semibold hover:bg-accent-hi">
                                {canManage ? (saving ? 'Creating…' : 'Create') : (saving ? 'Sending…' : 'Send request')}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>

            {/* ── Archive confirm ── */}
            <Dialog open={!!toArchive} onOpenChange={(v) => { if (!v) setToArchive(null); }}>
                <DialogContent className="w-[min(92vw,440px)] rounded-xl border-line bg-paper-1 p-5">
                    <DialogHeader>
                        <DialogTitle className="font-display text-base font-semibold text-ink">
                            Archive “{toArchive?.name}”?
                        </DialogTitle>
                        <DialogDescription className="text-xs text-ink-3">
                            The project is hidden and stops accepting new generations. Jobs, spend and audit history are kept,
                            and creating a project with the same name later revives it.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="mt-2 gap-2 sm:gap-2">
                        <Button variant="outline" onClick={() => setToArchive(null)}>Cancel</Button>
                        <Button variant="destructive" onClick={archive} disabled={archiving}>
                            {archiving ? 'Archiving…' : 'Archive project'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
