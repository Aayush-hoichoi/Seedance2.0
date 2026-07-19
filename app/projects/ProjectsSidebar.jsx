'use client';

// Left rail for the projects front door — the app-level nav that used to live
// inside the studio. Desktop-only (sm+); on mobile the page header keeps the
// account button. Collapse state is lifted so the page can shift its padding.

import Link from 'next/link';
import { UserButton } from '@clerk/nextjs';
import {
    FolderKanban, Clapperboard, Users, Heart, ShieldCheck,
    PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import ThemePicker from '../seedance/ThemePicker.jsx';

function Item({ icon: Icon, label, href, active, tone, collapsed }) {
    const cls = `flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${active
        ? 'bg-paper-2 text-ink'
        : tone === 'warn'
            ? 'text-warn/80 hover:bg-warn/10 hover:text-warn'
            : 'text-ink-3 hover:bg-paper-2 hover:text-ink-2'} ${collapsed ? 'justify-center' : ''}`;
    return (
        <Link href={href} title={label} className={cls}>
            <Icon size={16} className="shrink-0" />
            {!collapsed && <span className="truncate">{label}</span>}
        </Link>
    );
}

export default function ProjectsSidebar({ isAdmin, collapsed, onToggle }) {
    return (
        <aside className={`fixed left-0 top-0 z-40 hidden h-screen flex-col border-r border-line bg-paper-1 transition-all sm:flex ${collapsed ? 'w-14' : 'w-56'}`}>
            <Link href="/projects" title="loglineAI Studio" className="flex items-center gap-2.5 px-3 py-4 transition-opacity hover:opacity-90">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent font-display text-sm font-bold text-accent-ink">L</div>
                {!collapsed && (
                    <div className="min-w-0">
                        <div className="truncate font-display text-sm font-semibold text-ink">loglineAI Studio</div>
                        <div className="truncate text-[10px] text-ink-3">Cinematic AI video</div>
                    </div>
                )}
            </Link>

            <nav className="flex-1 space-y-0.5 overflow-y-auto px-2">
                <Item icon={FolderKanban} label="Projects" href="/projects" active collapsed={collapsed} />
                <Item icon={Clapperboard} label="Studio" href="/seedance" collapsed={collapsed} />
                <Item icon={Users} label="Gallery" href="/gallery" collapsed={collapsed} />
                <Item icon={Heart} label="Liked" href="/liked" collapsed={collapsed} />
                {isAdmin && <Item icon={ShieldCheck} label="Console" href="/console" tone="warn" collapsed={collapsed} />}
            </nav>

            <div className="space-y-1 border-t border-line p-2">
                <ThemePicker collapsed={collapsed} />
                <button type="button" onClick={onToggle} title="Toggle sidebar" className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-ink-3 hover:bg-paper-2 hover:text-ink-2 ${collapsed ? 'justify-center' : ''}`}>
                    {collapsed ? <PanelLeftOpen size={16} /> : <><PanelLeftClose size={16} /> <span>Collapse</span></>}
                </button>
                <div className={`flex items-center gap-2.5 px-1.5 py-1 ${collapsed ? 'justify-center' : ''}`}>
                    <div className="rounded-full ring-1 ring-line"><UserButton /></div>
                    {!collapsed && <span className="text-xs text-ink-3">Account</span>}
                </div>
            </div>
        </aside>
    );
}
