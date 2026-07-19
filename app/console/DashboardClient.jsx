'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import { Card, StatCard, PageHeader, Badge, ProgressBar, EmptyState, Input } from './ui.jsx';
import { useApi, fmtUsd, fmtInt, monthStartIso, dayStartIso, timeAgo } from './lib.js';
import { buildUserSpendSeries } from './spendSeries.mjs';
import { useEvents } from '../hooks/useEvents.js';
import { BellRing } from 'lucide-react';

const SpendLines = dynamic(() => import('./charts.jsx').then((m) => m.SpendLines), { ssr: false });
const TaskCostScatter = dynamic(() => import('./charts.jsx').then((m) => m.TaskCostScatter), { ssr: false });
const SpendDonut = dynamic(() => import('./charts.jsx').then((m) => m.SpendDonut), { ssr: false });
const TopBars = dynamic(() => import('./charts.jsx').then((m) => m.TopBars), { ssr: false });

export default function DashboardClient() {
    const today = dayStartIso();
    // Date filter (YYYY-MM-DD): defaults to this month; `to` empty = up to now.
    // The API's `to` is exclusive, so a picked end date sends end-of-day UTC.
    const [from, setFrom] = useState(monthStartIso().slice(0, 10));
    const [to, setTo] = useState('');
    const range = `from=${from}T00:00:00.000Z${to ? `&to=${to}T23:59:59.999Z` : ''}`;
    const byDay = useApi(`/api/orgs/usage?group_by=day&${range}`);
    const byDayUser = useApi(`/api/orgs/usage?group_by=day_user&${range}`);
    const byModel = useApi(`/api/orgs/usage?group_by=model&${range}`);
    const byUser = useApi(`/api/orgs/usage?group_by=user&${range}`);
    const byProject = useApi(`/api/orgs/usage?group_by=project&${range}`);
    const quotas = useApi('/api/admin/quotas?withUsage=1');
    const [alerts, setAlerts] = useState([]);

    useEvents('*', ({ type, data }) => {
        if (['budget.threshold_crossed', 'access.revoked', 'access.expired', 'project.paused'].includes(type)) {
            setAlerts((prev) => [{ type, data, at: new Date().toISOString() }, ...prev].slice(0, 20));
        }
    });

    const days = byDay.data?.items?.slice().sort((a, b) => (a.key < b.key ? -1 : 1)) ?? [];
    const userSpend = buildUserSpendSeries(byDayUser.data?.items);
    // Tasks SENT per day per user: settled + failed (a failed task was still sent).
    const userTasks = buildUserSpendSeries(
        (byDayUser.data?.items ?? []).map((r) => ({ ...r, tasks: Number(r.generations || 0) + Number(r.failures || 0) })),
        8, 'tasks',
    );
    const monthSpend = days.reduce((s, d) => s + Number(d.cost_usd || 0), 0);
    const todayKey = today.slice(0, 10);
    const todaySpend = Number(days.find((d) => d.key === todayKey)?.cost_usd || 0);
    const generations = days.reduce((s, d) => s + Number(d.generations || 0), 0);
    const failures = days.reduce((s, d) => s + Number(d.failures || 0), 0);
    const models = (byModel.data?.items ?? []).filter((m) => Number(m.cost_usd) > 0);
    const users = (byUser.data?.items ?? []).slice(0, 8);
    // Task-vs-cost performance: one dot per user over the whole period.
    const perf = (byUser.data?.items ?? [])
        .map((u) => ({ key: u.key, tasks: Number(u.generations || 0) + Number(u.failures || 0), cost_usd: Number(u.cost_usd || 0) }))
        .filter((u) => u.tasks > 0 || u.cost_usd > 0);
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
            <PageHeader title="Dashboard" subtitle="Org-wide spend, budgets and live governance activity">
                <label className="text-xs text-ink-3">From</label>
                <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="w-auto" />
                <label className="text-xs text-ink-3">To</label>
                <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="w-auto" />
            </PageHeader>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatCard label="Spend today" value={fmtUsd(todaySpend)} />
                <StatCard label="Spend in period" value={fmtUsd(monthSpend)} tone="blue" />
                <StatCard label="Generations" value={fmtInt(generations)} hint={`${fmtInt(failures)} failed`} />
                <StatCard label="Success rate" value={generations ? `${(((generations - failures) / generations) * 100).toFixed(1)}%` : '—'} tone={failures ? 'amber' : 'green'} />
            </div>

            <Card className="mt-4">
                <div className="mb-2 text-sm font-medium text-ink-2">
                    Spend by day · per user{userSpend.series.includes('Others') ? ' (top 8, rest as Others)' : ''}
                </div>
                {userSpend.data.length
                    ? <SpendLines data={userSpend.data} series={userSpend.series} />
                    : <div className="grid h-[320px] place-items-center text-xs text-ink-3">No settlements in this period</div>}
            </Card>

            <Card className="mt-4">
                <div className="mb-2 text-sm font-medium text-ink-2">
                    Tasks by day · per user{userTasks.series.includes('Others') ? ' (top 8, rest as Others)' : ''}
                </div>
                {userTasks.data.length
                    ? <SpendLines data={userTasks.data} series={userTasks.series} money={false} height={280} />
                    : <div className="grid h-[280px] place-items-center text-xs text-ink-3">No tasks in this period</div>}
            </Card>

            <Card className="mt-4">
                <div className="mb-2 text-sm font-medium text-ink-2">
                    Task vs cost · per user <span className="text-xs font-normal text-ink-3">— each dot is a user; higher-left = pricier per task</span>
                </div>
                {perf.length
                    ? <TaskCostScatter data={perf} />
                    : <div className="grid h-[280px] place-items-center text-xs text-ink-3">No usage in this period</div>}
            </Card>

            <div className="mt-4 grid gap-4 lg:grid-cols-3">
                <Card className="lg:col-span-2">
                    <div className="mb-2 text-sm font-medium text-ink-2">Top users</div>
                    {users.length ? <TopBars data={users} /> : <div className="grid h-[220px] place-items-center text-xs text-ink-3">No usage yet</div>}
                </Card>
                <div className="space-y-4">
                    <Card>
                        <div className="mb-2 text-sm font-medium text-ink-2">Spend by model</div>
                        {models.length ? <SpendDonut data={models} /> : <div className="grid h-[220px] place-items-center text-xs text-ink-3">No model spend yet</div>}
                    </Card>
                    <Card>
                        <div className="mb-3 text-sm font-medium text-ink-2">Budgets</div>
                        {budgetRows.length ? (
                            <div className="space-y-3">
                                {budgetRows.map((q) => (
                                    <div key={q.id}>
                                        <div className="mb-1 flex items-center justify-between text-xs">
                                            <span className="text-ink-2">
                                                {q.user_id ? 'user' : q.project_name || 'org'} · {q.type} · {q.window}
                                            </span>
                                            <span className="font-mono tabular-nums text-ink-2">
                                                {q.type === 'usd' ? fmtUsd(q.used) : fmtInt(q.used)} / {q.type === 'usd' ? fmtUsd(q.hard_limit) : fmtInt(q.hard_limit)}
                                            </span>
                                        </div>
                                        <ProgressBar value={Number(q.used) + Number(q.reserved || 0)} max={Number(q.hard_limit)} />
                                    </div>
                                ))}
                            </div>
                        ) : <div className="text-xs text-ink-3">No budgets configured — add them under Budgets.</div>}
                    </Card>
                    <Card>
                        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-ink-2"><BellRing size={14} /> Live alerts</div>
                        {alerts.length ? (
                            <ul className="space-y-2 text-xs">
                                {alerts.map((a, i) => (
                                    <li key={i} className="flex items-start justify-between gap-2">
                                        <span className="text-ink-2">
                                            <Badge tone={a.type === 'budget.threshold_crossed' ? 'amber' : 'red'} className="mr-1.5">{a.type.split('.')[0]}</Badge>
                                            {a.type === 'budget.threshold_crossed'
                                                ? `${a.data?.threshold}% of ${a.data?.type} ${a.data?.window} budget`
                                                : a.data?.modelId || a.type}
                                        </span>
                                        <span className="shrink-0 font-mono text-ink-3">{timeAgo(a.at)}</span>
                                    </li>
                                ))}
                            </ul>
                        ) : <div className="text-xs text-ink-3">Quiet — governance events will appear here in real time.</div>}
                    </Card>
                </div>
            </div>

            {projects.length ? (
                <Card className="mt-4">
                    <div className="mb-2 text-sm font-medium text-ink-2">Spend by project</div>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {projects.map((p) => (
                            <div key={p.key} className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm">
                                <span className="text-ink-2">Project #{p.key}</span>
                                <span className="font-mono tabular-nums text-ink">{fmtUsd(p.cost_usd)}</span>
                            </div>
                        ))}
                    </div>
                </Card>
            ) : null}
        </div>
    );
}
