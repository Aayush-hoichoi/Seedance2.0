'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import { Card, StatCard, PageHeader, Badge, ProgressBar, EmptyState } from './ui.jsx';
import { useApi, fmtUsd, fmtInt, monthStartIso, dayStartIso, timeAgo } from './lib.js';
import { useEvents } from '../hooks/useEvents.js';
import { BellRing } from 'lucide-react';

const SpendArea = dynamic(() => import('./charts.jsx').then((m) => m.SpendArea), { ssr: false });
const SpendDonut = dynamic(() => import('./charts.jsx').then((m) => m.SpendDonut), { ssr: false });
const TopBars = dynamic(() => import('./charts.jsx').then((m) => m.TopBars), { ssr: false });

export default function DashboardClient() {
    const month = monthStartIso();
    const today = dayStartIso();
    const byDay = useApi(`/api/orgs/usage?group_by=day&from=${month}`);
    const byModel = useApi(`/api/orgs/usage?group_by=model&from=${month}`);
    const byUser = useApi(`/api/orgs/usage?group_by=user&from=${month}`);
    const byProject = useApi(`/api/orgs/usage?group_by=project&from=${month}`);
    const quotas = useApi('/api/admin/quotas?withUsage=1');
    const [alerts, setAlerts] = useState([]);

    useEvents('*', ({ type, data }) => {
        if (['budget.threshold_crossed', 'access.revoked', 'access.expired', 'project.paused'].includes(type)) {
            setAlerts((prev) => [{ type, data, at: new Date().toISOString() }, ...prev].slice(0, 20));
        }
    });

    const days = byDay.data?.items?.slice().sort((a, b) => (a.key < b.key ? -1 : 1)) ?? [];
    const monthSpend = days.reduce((s, d) => s + Number(d.cost_usd || 0), 0);
    const todayKey = today.slice(0, 10);
    const todaySpend = Number(days.find((d) => d.key === todayKey)?.cost_usd || 0);
    const generations = days.reduce((s, d) => s + Number(d.generations || 0), 0);
    const failures = days.reduce((s, d) => s + Number(d.failures || 0), 0);
    const models = (byModel.data?.items ?? []).filter((m) => Number(m.cost_usd) > 0);
    const users = (byUser.data?.items ?? []).slice(0, 8);
    const projects = byProject.data?.items ?? [];
    const budgetRows = (quotas.data?.items ?? []).slice(0, 6);

    const forbidden = byDay.error?.code === 'FORBIDDEN';
    if (forbidden) {
        return (
            <EmptyState title="Admin access required"
                hint="Org-wide dashboards are for gateway admins. Ask an admin to grant your account the admin role, or use your project pages under Projects." />
        );
    }

    return (
        <div>
            <PageHeader title="Dashboard" subtitle="Org-wide spend, budgets and live governance activity (this month)" />
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatCard label="Spend today" value={fmtUsd(todaySpend)} />
                <StatCard label="Spend this month" value={fmtUsd(monthSpend)} tone="blue" />
                <StatCard label="Generations" value={fmtInt(generations)} hint={`${fmtInt(failures)} failed`} />
                <StatCard label="Success rate" value={generations ? `${(((generations - failures) / generations) * 100).toFixed(1)}%` : '—'} tone={failures ? 'amber' : 'green'} />
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-3">
                <Card className="lg:col-span-2">
                    <div className="mb-2 text-sm font-medium text-zinc-300">Spend by day</div>
                    {days.length ? <SpendArea data={days} /> : <div className="grid h-[220px] place-items-center text-xs text-zinc-600">No settlements yet this month</div>}
                </Card>
                <Card>
                    <div className="mb-2 text-sm font-medium text-zinc-300">Spend by model</div>
                    {models.length ? <SpendDonut data={models} /> : <div className="grid h-[220px] place-items-center text-xs text-zinc-600">No model spend yet</div>}
                </Card>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-3">
                <Card className="lg:col-span-2">
                    <div className="mb-2 text-sm font-medium text-zinc-300">Top users</div>
                    {users.length ? <TopBars data={users} /> : <div className="grid h-[220px] place-items-center text-xs text-zinc-600">No usage yet</div>}
                </Card>
                <div className="space-y-4">
                    <Card>
                        <div className="mb-3 text-sm font-medium text-zinc-300">Budgets</div>
                        {budgetRows.length ? (
                            <div className="space-y-3">
                                {budgetRows.map((q) => (
                                    <div key={q.id}>
                                        <div className="mb-1 flex items-center justify-between text-xs">
                                            <span className="text-zinc-400">
                                                {q.user_id ? 'user' : q.project_name || 'org'} · {q.type} · {q.window}
                                            </span>
                                            <span className="tabular-nums text-zinc-300">
                                                {q.type === 'usd' ? fmtUsd(q.used) : fmtInt(q.used)} / {q.type === 'usd' ? fmtUsd(q.hard_limit) : fmtInt(q.hard_limit)}
                                            </span>
                                        </div>
                                        <ProgressBar value={Number(q.used) + Number(q.reserved || 0)} max={Number(q.hard_limit)} />
                                    </div>
                                ))}
                            </div>
                        ) : <div className="text-xs text-zinc-600">No budgets configured — add them under Budgets.</div>}
                    </Card>
                    <Card>
                        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-300"><BellRing size={14} /> Live alerts</div>
                        {alerts.length ? (
                            <ul className="space-y-2 text-xs">
                                {alerts.map((a, i) => (
                                    <li key={i} className="flex items-start justify-between gap-2">
                                        <span className="text-zinc-400">
                                            <Badge tone={a.type === 'budget.threshold_crossed' ? 'amber' : 'red'} className="mr-1.5">{a.type.split('.')[0]}</Badge>
                                            {a.type === 'budget.threshold_crossed'
                                                ? `${a.data?.threshold}% of ${a.data?.type} ${a.data?.window} budget`
                                                : a.data?.modelId || a.type}
                                        </span>
                                        <span className="shrink-0 text-zinc-600">{timeAgo(a.at)}</span>
                                    </li>
                                ))}
                            </ul>
                        ) : <div className="text-xs text-zinc-600">Quiet — governance events will appear here in real time.</div>}
                    </Card>
                </div>
            </div>

            {projects.length ? (
                <Card className="mt-4">
                    <div className="mb-2 text-sm font-medium text-zinc-300">Spend by project</div>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {projects.map((p) => (
                            <div key={p.key} className="flex items-center justify-between rounded-lg border border-zinc-800 px-3 py-2 text-sm">
                                <span className="text-zinc-300">Project #{p.key}</span>
                                <span className="tabular-nums text-zinc-100">{fmtUsd(p.cost_usd)}</span>
                            </div>
                        ))}
                    </div>
                </Card>
            ) : null}
        </div>
    );
}
