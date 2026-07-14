'use client';

// Collapsible left sidebar for the studio — collects what used to live in the
// top toolbar (project scope, spend, nav, account) into one rail, mirroring the
// console shell. Desktop-only (sm+); a compact bar covers mobile in the studio.

import Link from 'next/link';
import { UserButton } from '@clerk/nextjs';
import {
    FolderKanban, LayoutGrid, Users, Heart, ShieldCheck,
    PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import ProjectSelect from './ProjectSelect.jsx';
import ThemePicker from './ThemePicker.jsx';

function Item({ icon: Icon, label, href, onClick, badge, tone, collapsed }) {
    const cls = `relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${tone === 'warn'
        ? 'text-warn/80 hover:bg-warn/10 hover:text-warn'
        : 'text-ink-3 hover:bg-paper-2 hover:text-ink-2'} ${collapsed ? 'justify-center' : ''}`;
    const inner = (
        <>
            <Icon size={16} className="shrink-0" />
            {!collapsed && <span className="truncate">{label}</span>}
            {!collapsed && badge != null && badge > 0 && <span className="ml-auto font-mono text-[11px] tabular-nums text-ink-3">{badge}</span>}
        </>
    );
    return href
        ? <Link href={href} title={label} className={cls}>{inner}</Link>
        : <button type="button" onClick={onClick} title={label} className={`${cls} w-full`}>{inner}</button>;
}

export default function StudioSidebar({
    collapsed, onToggle, onHome, activeCount, monthSpend,
    projects, projectId, selectProject, isAdmin, doneCount, onOpenAssets,
}) {
    return (
        <aside className={`fixed left-0 top-0 z-40 hidden h-screen flex-col border-r border-line bg-paper-1 transition-all sm:flex ${collapsed ? 'w-14' : 'w-56'}`}>
            <button type="button" onClick={onHome} title="Home — back to the studio" className="flex items-center gap-2.5 px-3 py-4 text-left transition-opacity hover:opacity-90">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent font-display text-sm font-bold text-accent-ink">S</div>
                {!collapsed && (
                    <div className="min-w-0">
                        <div className="truncate font-display text-sm font-semibold text-ink">Seedance 2.0</div>
                        <div className="truncate text-[10px] text-ink-3">
                            {activeCount > 0 ? <span className="text-accent-hi">{activeCount} rendering…</span> : 'BytePlus ModelArk'}
                        </div>
                    </div>
                )}
            </button>

            {!collapsed && projects.length > 0 && (
                <div className="px-2 pb-2">
                    <ProjectSelect projects={projects} value={projectId} onChange={selectProject} block />
                </div>
            )}

            <nav className="flex-1 space-y-0.5 overflow-y-auto px-2">
                <Item icon={FolderKanban} label="Projects" href="/projects" collapsed={collapsed} />
                <Item icon={LayoutGrid} label="Assets" onClick={onOpenAssets} badge={doneCount} collapsed={collapsed} />
                <Item icon={Users} label="Gallery" href="/gallery" collapsed={collapsed} />
                <Item icon={Heart} label="Liked" href="/liked" collapsed={collapsed} />
                {isAdmin && <Item icon={ShieldCheck} label="Console" href="/console" tone="warn" collapsed={collapsed} />}
            </nav>

            <div className="space-y-1 border-t border-line p-2">
                <ThemePicker collapsed={collapsed} />
                {monthSpend != null && !collapsed && (
                    <div className="px-1.5 py-1" title="What your generations cost this calendar month">
                        <div className="text-[10px] uppercase tracking-wider text-ink-3">This month</div>
                        <div className="font-mono text-sm font-semibold tabular-nums text-ink">${monthSpend.toFixed(2)}</div>
                    </div>
                )}
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
