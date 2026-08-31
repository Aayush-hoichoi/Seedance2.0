'use client';

// Console chrome: collapsible left nav, live-events indicator, event toasts.

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { UserButton } from '@clerk/nextjs';
import toast, { Toaster } from 'react-hot-toast';
import { useSWRConfig } from 'swr';
import clsx from 'clsx';
import {
    LayoutDashboard, FolderKanban, Boxes, ListOrdered, BarChart3,
    Wallet, ScrollText, Users, Clapperboard, PanelLeftClose, PanelLeftOpen, Radio, BellRing,
    Table2, Bug, Menu,
} from 'lucide-react';
import { useEvents } from '../hooks/useEvents.js';
import { useApi } from './lib.js';

// managerOk marks the only tab org managers may see — everything else is
// admin-only (and the APIs behind them already reject non-admins).
const NAV = [
    { href: '/console', label: 'Dashboard', icon: LayoutDashboard, exact: true },
    { href: '/console/projects', label: 'Projects', icon: FolderKanban, managerOk: true },
    { href: '/console/models', label: 'Models', icon: Boxes },
    { href: '/console/queue', label: 'Queue', icon: ListOrdered },
    { href: '/console/ledger', label: 'Ledger', icon: Table2 },
    { href: '/console/usage', label: 'Usage', icon: BarChart3 },
    { href: '/console/budgets', label: 'Budgets', icon: Wallet },
    { href: '/console/budget-requests', label: 'Budget requests', icon: BellRing },
    { href: '/console/issues', label: 'Issues', icon: Bug },
    { href: '/console/audit', label: 'Audit', icon: ScrollText },
    { href: '/console/users', label: 'Users', icon: Users },
];

// SWR keys touched by each event type — live updates without poll loops.
const REVALIDATE = {
    'job.status_changed': ['/api/generations', '/api/admin/quotas?withUsage=1'],
    'access.granted': ['/api/projects'],
    'access.revoked': ['/api/projects'],
    'access.expired': ['/api/projects'],
    'access.request.denied': ['/api/admin/requests'],
    'budget.threshold_crossed': ['/api/admin/quotas?withUsage=1'],
    'budget.requested': ['/api/admin/budget-requests'],
    'budget.request.approved': ['/api/admin/budget-requests', '/api/admin/quotas?withUsage=1'],
    'budget.request.denied': ['/api/admin/budget-requests'],
    'project.paused': ['/api/projects'],
    'project.resumed': ['/api/projects'],
    'issue.reported': ['/api/admin/issues'],
    'issue.decided': ['/api/admin/issues'],
};

export default function ConsoleShell({ children }) {
    const [collapsed, setCollapsed] = useState(false);
    const [navOpen, setNavOpen] = useState(false); // mobile drawer (below md the rail is off-canvas)
    const [live, setLive] = useState(false);
    const pathname = usePathname();
    const { mutate } = useSWRConfig();
    // Only platform admins see every tab; managers get Projects only. Default
    // to the restricted set until confirmed admin so extra tabs never flash.
    const { data: me } = useApi('/api/projects');
    const isAdmin = me?.role === 'admin';
    const { data: budgetRequests } = useApi(isAdmin ? '/api/admin/budget-requests' : null);
    const pendingBudgetRequests = (budgetRequests?.requests ?? []).filter((request) => request.status === 'pending').length;
    const { data: issues } = useApi(isAdmin ? '/api/admin/issues' : null);
    const openIssues = (issues?.issues ?? []).filter((issue) => issue.status === 'open').length;
    const nav = isAdmin ? NAV : NAV.filter((n) => n.managerOk);
    // A manager who reaches an admin-only console route by URL is bounced to
    // Projects (the APIs already deny the data; this hides the empty shell).
    const router = useRouter();
    useEffect(() => { setNavOpen(false); }, [pathname]); // navigating closes the mobile drawer
    useEffect(() => {
        if (!navOpen) return undefined;
        const closeOnEscape = (event) => { if (event.key === 'Escape') setNavOpen(false); };
        window.addEventListener('keydown', closeOnEscape);
        return () => window.removeEventListener('keydown', closeOnEscape);
    }, [navOpen]);
    useEffect(() => {
        if (me && !isAdmin) {
            const allowed = nav.some((n) => (n.exact ? pathname === n.href : pathname.startsWith(n.href)));
            if (!allowed) router.replace('/console/projects');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [me, isAdmin, pathname]);

    useEvents('*', ({ type, data }) => {
        setLive(true);
        for (const keyPrefix of REVALIDATE[type] || []) {
            mutate((key) => typeof key === 'string' && key.startsWith(keyPrefix), undefined, { revalidate: true });
        }
        if (type === 'budget.threshold_crossed') {
            toast(`Budget at ${data?.threshold}% — ${data?.type} ${data?.window} limit ${data?.limit}`, { icon: '⚠️' });
        }
        if (type === 'budget.requested') {
            toast(`${data?.userName || 'A user'} requested ${Number(data?.increaseAmount || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} for ${data?.modelName || 'models'} in ${data?.projectName || 'a project'}.`, { icon: '🔔', duration: 7000 });
        }
        if (type === 'issue.reported') {
            toast(`${data?.userName || 'A user'} hit an issue on ${data?.modelName || 'a model'} in ${data?.projectName || 'a project'} — ${data?.errorSummary || 'generation failed'}`, { icon: '🐞', duration: 7000 });
        }
        if (type === 'access.revoked') toast(`Access revoked: ${data?.modelId}`, { icon: '🔒' });
        if (type === 'project.paused') toast('Project paused by an admin', { icon: '⏸️' });
    });

    return (
        <div className="flex min-h-screen bg-app-bg text-ink">
            <Toaster position="bottom-right" toastOptions={{ style: { background: '#1A1A21', color: '#F4F3F7', border: '1px solid #2A2A34' } }} />
            {/* Below md the rail is an off-canvas drawer; from md it is the
                sticky column it has always been (collapsible). */}
            {navOpen && <button type="button" aria-label="Close menu" className="fixed inset-0 z-40 bg-black/60 md:hidden" onClick={() => setNavOpen(false)} />}
            <aside id="console-navigation" className={clsx(
                'fixed inset-y-0 left-0 z-50 flex w-56 flex-col border-r border-line bg-paper-1 transition-transform',
                'md:sticky md:top-0 md:h-screen md:translate-x-0 md:transition-all',
                navOpen ? 'visible translate-x-0' : 'invisible -translate-x-full md:visible',
                collapsed ? 'md:w-14' : 'md:w-56',
            )}>
                <div className="flex items-center gap-2.5 px-3 py-4">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent font-display text-sm font-bold text-accent-ink">L</div>
                    {!collapsed && <div className="font-display text-sm font-semibold tracking-tight text-ink">loglineAI Studio</div>}
                </div>
                <nav className="flex-1 space-y-0.5 px-2">
                    {nav.map(({ href, label, icon: Icon, exact }) => {
                        const active = exact ? pathname === href : pathname.startsWith(href);
                        return (
                            <Link key={href} href={href} title={label}
                                className={clsx('relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
                                    active ? 'bg-paper-3 font-medium text-ink' : 'text-ink-3 hover:bg-paper-2 hover:text-ink-2')}>
                                {active && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" />}
                                <Icon size={16} className="shrink-0" />
                                {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
                                {(() => {
                                    const badge = label === 'Budget requests' ? pendingBudgetRequests
                                        : label === 'Issues' ? openIssues : 0;
                                    return badge > 0 ? (
                                        <span className="grid min-w-5 place-items-center rounded-full bg-warn/15 px-1 text-[10px] font-semibold text-warn">
                                            {badge > 99 ? '99+' : badge}
                                        </span>
                                    ) : null;
                                })()}
                            </Link>
                        );
                    })}
                </nav>
                <div className="space-y-1 border-t border-line p-2">
                    <Link href="/seedance" title="Back to Studio"
                        className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-ink-3 hover:bg-paper-2 hover:text-ink-2">
                        <Clapperboard size={16} className="shrink-0" />
                        {!collapsed && 'Studio'}
                    </Link>
                    <button onClick={() => setCollapsed(!collapsed)} title="Toggle sidebar"
                        className="hidden w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-ink-3 hover:bg-paper-2 hover:text-ink-2 md:flex">
                        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
                        {!collapsed && 'Collapse'}
                    </button>
                </div>
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
                <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-2 border-b border-line bg-app-bg/90 px-4 backdrop-blur sm:px-6">
                    <div className="flex min-w-0 items-center gap-2 text-xs text-ink-3">
                        <button type="button" onClick={() => setNavOpen(true)} aria-label="Open menu"
                            aria-controls="console-navigation" aria-expanded={navOpen}
                            className="-ml-1 rounded-md p-1.5 text-ink-2 hover:bg-paper-2 md:hidden">
                            <Menu size={18} />
                        </button>
                        <Radio size={13} className={live ? 'text-ok' : 'text-ink-3'} />
                        <span className="truncate">{live ? <><span className="hidden sm:inline">Live — governance events streaming</span><span className="sm:hidden">Live</span></> : 'Connecting…'}</span>
                    </div>
                    <div className="shrink-0 rounded-full ring-1 ring-line"><UserButton afterSignOutUrl="/sign-in" /></div>
                </header>
                <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 sm:px-6 sm:py-6">{children}</main>
            </div>
        </div>
    );
}
