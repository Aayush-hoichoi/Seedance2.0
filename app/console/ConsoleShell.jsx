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
        <div className="flex min-h-screen bg-zinc-950 text-zinc-100">
            <Toaster position="bottom-right" toastOptions={{ style: { background: '#18181b', color: '#e4e4e7', border: '1px solid #3f3f46' } }} />
            <aside className={clsx('sticky top-0 flex h-screen flex-col border-r border-zinc-800 bg-zinc-950 transition-all', collapsed ? 'w-14' : 'w-56')}>
                <div className="flex items-center gap-2 px-3 py-4">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-sky-600 text-sm font-bold">G</div>
                    {!collapsed && <div className="text-sm font-semibold tracking-tight">Model Gateway</div>}
                </div>
                <nav className="flex-1 space-y-0.5 px-2">
                    {NAV.map(({ href, label, icon: Icon, exact }) => {
                        const active = exact ? pathname === href : pathname.startsWith(href);
                        return (
                            <Link key={href} href={href} title={label}
                                className={clsx('flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
                                    active ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200')}>
                                <Icon size={16} className="shrink-0" />
                                {!collapsed && label}
                            </Link>
                        );
                    })}
                </nav>
                <div className="space-y-1 border-t border-zinc-800 p-2">
                    <Link href="/seedance" title="Back to Studio"
                        className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200">
                        <Clapperboard size={16} className="shrink-0" />
                        {!collapsed && 'Studio'}
                    </Link>
                    <button onClick={() => setCollapsed(!collapsed)} title="Toggle sidebar"
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300">
                        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
                        {!collapsed && 'Collapse'}
                    </button>
                </div>
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
                <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-zinc-800 bg-zinc-950/90 px-6 backdrop-blur">
                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                        <Radio size={13} className={live ? 'text-emerald-400' : 'text-zinc-600'} />
                        {live ? 'Live — governance events streaming' : 'Connecting…'}
                    </div>
                    <UserButton afterSignOutUrl="/sign-in" />
                </header>
                <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">{children}</main>
            </div>
        </div>
    );
}
