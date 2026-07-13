'use client';

// Console chrome: collapsible left nav, live-events indicator, event toasts.

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { UserButton } from '@clerk/nextjs';
import toast, { Toaster } from 'react-hot-toast';
import { useSWRConfig } from 'swr';
import clsx from 'clsx';
import {
    LayoutDashboard, FolderKanban, Boxes, ListOrdered, BarChart3,
    Wallet, ScrollText, Users, Clapperboard, PanelLeftClose, PanelLeftOpen, Radio,
} from 'lucide-react';
import { useEvents } from '../hooks/useEvents.js';

const NAV = [
    { href: '/console', label: 'Dashboard', icon: LayoutDashboard, exact: true },
    { href: '/console/projects', label: 'Projects', icon: FolderKanban },
    { href: '/console/models', label: 'Models', icon: Boxes },
    { href: '/console/queue', label: 'Queue', icon: ListOrdered },
    { href: '/console/usage', label: 'Usage', icon: BarChart3 },
    { href: '/console/budgets', label: 'Budgets', icon: Wallet },
    { href: '/console/audit', label: 'Audit', icon: ScrollText },
    { href: '/console/users', label: 'Users', icon: Users },
];

// SWR keys touched by each event type — live updates without poll loops.
const REVALIDATE = {
    'job.status_changed': ['/api/generations', '/api/admin/quotas?withUsage=1'],
    'access.granted': ['/api/projects'],
    'access.revoked': ['/api/projects'],
    'access.expired': ['/api/projects'],
    'budget.threshold_crossed': ['/api/admin/quotas?withUsage=1'],
    'project.paused': ['/api/projects'],
    'project.resumed': ['/api/projects'],
};

export default function ConsoleShell({ children }) {
    const [collapsed, setCollapsed] = useState(false);
    const [live, setLive] = useState(false);
    const pathname = usePathname();
    const { mutate } = useSWRConfig();

    useEvents('*', ({ type, data }) => {
        setLive(true);
        for (const keyPrefix of REVALIDATE[type] || []) {
            mutate((key) => typeof key === 'string' && key.startsWith(keyPrefix), undefined, { revalidate: true });
        }
        if (type === 'budget.threshold_crossed') {
            toast(`Budget at ${data?.threshold}% — ${data?.type} ${data?.window} limit ${data?.limit}`, { icon: '⚠️' });
        }
        if (type === 'access.revoked') toast(`Access revoked: ${data?.modelId}`, { icon: '🔒' });
        if (type === 'project.paused') toast('Project paused by an admin', { icon: '⏸️' });
    });

    return (
        <div className="flex min-h-screen bg-app-bg text-ink">
            <Toaster position="bottom-right" toastOptions={{ style: { background: '#1A1A21', color: '#F4F3F7', border: '1px solid #2A2A34' } }} />
            <aside className={clsx('sticky top-0 flex h-screen flex-col border-r border-line bg-paper-1 transition-all', collapsed ? 'w-14' : 'w-56')}>
                <div className="flex items-center gap-2.5 px-3 py-4">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent font-display text-sm font-bold text-accent-ink">G</div>
                    {!collapsed && <div className="font-display text-sm font-semibold tracking-tight text-ink">Model Gateway</div>}
                </div>
                <nav className="flex-1 space-y-0.5 px-2">
                    {NAV.map(({ href, label, icon: Icon, exact }) => {
                        const active = exact ? pathname === href : pathname.startsWith(href);
                        return (
                            <Link key={href} href={href} title={label}
                                className={clsx('relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
                                    active ? 'bg-paper-3 font-medium text-ink' : 'text-ink-3 hover:bg-paper-2 hover:text-ink-2')}>
                                {active && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" />}
                                <Icon size={16} className="shrink-0" />
                                {!collapsed && label}
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
                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-ink-3 hover:bg-paper-2 hover:text-ink-2">
                        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
                        {!collapsed && 'Collapse'}
                    </button>
                </div>
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
                <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-line bg-app-bg/90 px-6 backdrop-blur">
                    <div className="flex items-center gap-2 text-xs text-ink-3">
                        <Radio size={13} className={live ? 'text-ok' : 'text-ink-3'} />
                        {live ? 'Live — governance events streaming' : 'Connecting…'}
                    </div>
                    <div className="rounded-full ring-1 ring-line"><UserButton afterSignOutUrl="/sign-in" /></div>
                </header>
                <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">{children}</main>
            </div>
        </div>
    );
}
