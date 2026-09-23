'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import { Card, StatCard, PageHeader, Badge, ProgressBar, EmptyState, DateRangePicker, Select } from './ui.jsx';
import { useApi, fmtUsd, fmtInt, istDate, istInstant, timeAgo } from './lib.js';
import { buildUserSpendSeries } from './spendSeries.mjs';
import { useEvents } from '../hooks/useEvents.js';
import { BellRing } from 'lucide-react';

const SpendLines = dynamic(() => import('./charts.jsx').then((m) => m.SpendLines), { ssr: false });
const TaskCostLines = dynamic(() => import('./charts.jsx').then((m) => m.TaskCostLines), { ssr: false });
const SpendDonut = dynamic(() => import('./charts.jsx').then((m) => m.SpendDonut), { ssr: false });
const TopBars = dynamic(() => import('./charts.jsx').then((m) => m.TopBars), { ssr: false });

export default function DashboardClient() {
    // Date filter (YYYY-MM-DD, IST days): defaults to this month; `to` empty =
    // up to now. The API's `to` is exclusive, so a picked end date sends
    // end-of-day IST.
    const [from, setFrom] = useState(`${istDate().slice(0, 7)}-01`);
    const [to, setTo] = useState('');
    // Which dimension the by-day line charts split on: one line per user,
    // per model, or per project (day_user / day_model / day_project rollups).
    const [dim, setDim] = useState('user');
    const range = `from=${istInstant(from)}${to ? `&to=${istInstant(to, '23:59:59.999')}` : ''}`;
    const byDay = useApi(`/api/orgs/usage?group_by=day&${range}`);
    const byDaySeries = useApi(`/api/orgs/usage?group_by=day_${dim}&${range}`);
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
    // Every series gets its own line (topN Infinity — no 'Others' fold), and
    // the picker narrows both by-day charts to one user/model/project.
    const [seriesFilter, setSeriesFilter] = useState('');
    const allSeries = [...new Set((byDaySeries.data?.items ?? []).map((r) => r.series))].sort();
    const dayRows = (byDaySeries.data?.items ?? []).filter((r) => !seriesFilter || r.series === seriesFilter);
    const userSpend = buildUserSpendSeries(dayRows, Infinity);
    // Tasks SENT per day: settled + failed (a failed task was still sent).
    const userTasks = buildUserSpendSeries(
        dayRows.map((r) => ({ ...r, tasks: Number(r.generations || 0) + Number(r.failures || 0) })),
        Infinity, 'tasks',
    );
    const shortName = (v) => String(v).split('@')[0];
    const chartScope = seriesFilter ? shortName(seriesFilter) : `per ${dim}`;
    const monthSpend = days.reduce((s, d) => s + Number(d.cost_usd || 0), 0);
    const todayKey = istDate();
    const todaySpend = Number(days.find((d) => d.key === todayKey)?.cost_usd || 0);
    const generations = days.reduce((s, d) => s + Number(d.generations || 0), 0);
    const failures = days.reduce((s, d) => s + Number(d.failures || 0), 0);
    const models = (byModel.data?.items ?? []).filter((m) => Number(m.cost_usd) > 0);
    const users = (byUser.data?.items ?? []).slice(0, 8);
    // Task-vs-cost performance per day: spend line vs tasks-sent line.
    const perf = days.map((d) => ({
        key: d.key,
        tasks: Number(d.generations || 0) + Number(d.failures || 0),
        cost_usd: Number(d.cost_usd || 0),
    }));
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
                <div className="flex items-center gap-1 rounded-lg border border-line bg-paper-2 p-1" role="tablist">
                    {['user', 'model', 'project'].map((d) => (
                        <button key={d} type="button" role="tab" aria-selected={dim === d}
                            onClick={() => { setDim(d); setSeriesFilter(''); }}
                            className={`rounded-md px-2.5 py-1.5 text-xs font-semibold capitalize transition-colors ${dim === d ? 'bg-paper-3 text-ink' : 'text-ink-3 hover:text-ink-2'}`}>
                            {d}
                        </button>
                    ))}
                </div>
                <Select title={`Focus the by-day charts on one ${dim}`} value={seriesFilter}
                    onChange={(e) => setSeriesFilter(e.target.value)} disabled={!allSeries.length}>
                    <option value="">All {dim}s</option>
                    {allSeries.map((u) => <option key={u} value={u}>{shortName(u)}</option>)}
                </Select>
                <DateRangePicker from={from} to={to}
                    onChange={({ from: f, to: t }) => { if (f) setFrom(f); setTo(t); }} />
            </PageHeader>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatCard label="Spend today" value={fmtUsd(todaySpend)} />
                <StatCard label="Spend in period" value={fmtUsd(monthSpend)} tone="blue" />
                <StatCard label="Generations" value={fmtInt(generations)} hint={`${fmtInt(failures)} failed`} />
                <StatCard label="Success rate" value={generations ? `${(((generations - failures) / generations) * 100).toFixed(1)}%` : '—'} tone={failures ? 'amber' : 'green'} />
            </div>

            <Card className="mt-4">
                <div className="mb-2 text-sm font-medium text-ink-2">
                    Spend by day · {chartScope}
                </div>
                {userSpend.data.length
                    ? <SpendLines data={userSpend.data} series={userSpend.series} />
                    : <div className="grid h-[320px] place-items-center text-xs text-ink-3">No settlements in this period</div>}
            </Card>

            <Card className="mt-4">
                <div className="mb-2 text-sm font-medium text-ink-2">
                    Tasks by day · {chartScope}
                </div>
                {userTasks.data.length
                    ? <SpendLines data={userTasks.data} series={userTasks.series} money={false} height={280} />
                    : <div className="grid h-[280px] place-items-center text-xs text-ink-3">No tasks in this period</div>}
            </Card>

            <Card className="mt-4">
                <div className="mb-2 text-sm font-medium text-ink-2">
                    Task vs cost · per day <span className="text-xs font-normal text-ink-3">— spend on the left axis, tasks sent on the right; diverging lines = pricier tasks</span>
                </div>
                {perf.length
                    ? <TaskCostLines data={perf} />
                    : <div className="grid h-[280px] place-items-center text-xs text-ink-3">No usage in this period</div>}
            </Card>

            {/* items-start: the right column (donut + budgets + alerts) is much
                taller than the Top users bars; without it the bars card
                stretches into a mostly-empty box. */}
            <div className="mt-4 grid items-start gap-4 lg:grid-cols-3">
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
                                                {q.user_id ? 'user' : q.project_name || 'org'}{q.model_name ? ` · ${q.model_name}` : ''} · {q.type} · {q.window}
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
                                <span className="text-ink-2">{p.key}</span>
                                <span className="font-mono tabular-nums text-ink">{fmtUsd(p.cost_usd)}</span>
                            </div>
                        ))}
                    </div>
                </Card>
            ) : null}
        </div>
    );
}
