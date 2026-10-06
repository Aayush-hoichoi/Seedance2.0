'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import clsx from 'clsx';
import { ShieldCheck } from 'lucide-react';
import { PageHeader, Card, StatCard, Select, Badge, ProgressBar, EmptyState } from '../ui.jsx';
import { useApi, fmtUsd, fmtInt } from '../lib.js';

const SpendDonut = dynamic(() => import('../charts.jsx').then((m) => m.SpendDonut), { ssr: false });
const TopBars = dynamic(() => import('../charts.jsx').then((m) => m.TopBars), { ssr: false });

// Why each model is (or isn't) usable — rule names come straight from
// effectiveAccess so the page explains the gateway's actual decision.
const RULES = {
    allow_override: { label: 'personal allow', chip: 'border-accent/40 bg-accent/10 text-accent-hi' },
    project_grant: { label: 'project grant', chip: 'border-ok/40 bg-ok/10 text-ok' },
    org_default: { label: 'org default', chip: 'border-line bg-paper-3 text-ink-2' },
    deny_override: { label: 'personal deny', chip: 'border-danger/40 bg-danger/10 text-danger line-through' },
    deny_default: { label: 'no access', chip: 'border-line bg-transparent text-ink-3 opacity-60' },
};

function quotaAmount(type, n) {
    return type === 'usd' || type === 'credits' ? fmtUsd(n) : `${fmtInt(n)} ${type.replace('_', ' ')}`;
}

// Access explorer: pick a user, see every project they can touch, which
// models the gateway lets them use there and why, and what they spent.
export default function AccessClient() {
    const router = useRouter();
    const [userId, setUserId] = useState(useSearchParams().get('user') || '');
    const { data: roster } = useApi('/api/admin/users');
    const users = (roster?.users ?? []).slice().sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
    const { data, error, isLoading } = useApi(userId ? `/api/admin/users/${encodeURIComponent(userId)}/access` : null);

    const pick = (id) => {
        setUserId(id);
        router.replace(id ? `/console/access?user=${encodeURIComponent(id)}` : '/console/access');
    };

    const projects = data?.projects ?? [];
    const memberProjects = projects.filter((p) => p.member);
    const allowedModelIds = new Set(memberProjects.flatMap((p) => p.access.filter((a) => a.allowed).map((a) => a.model_id)));
    const donutData = projects.filter((p) => p.cost_usd > 0).map((p) => ({ key: p.name, cost_usd: p.cost_usd }));

    return (
        <div>
            <PageHeader title="Access" subtitle="One user's whole picture — projects, model access and spend">
                <Select value={userId} onChange={(e) => pick(e.target.value)} title="Pick a user">
                    <option value="">Pick a user…</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
                </Select>
            </PageHeader>

            {!userId ? (
                <EmptyState icon={ShieldCheck} title="Pick a user to explore"
                    hint="See every project they belong to, which models they can use there and why, their spend split, and their personal budgets." />
            ) : error ? (
                <Card className="text-sm text-danger">Could not load this user’s access report.</Card>
            ) : isLoading || !data ? (
                <Card className="grid h-40 place-items-center text-xs text-ink-3">Loading…</Card>
            ) : (
                <>
                    <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                        <StatCard label="Total spend" value={fmtUsd(data.totals.cost_usd)} hint="all time, all projects" />
                        <StatCard label="Generations" value={fmtInt(data.totals.generations)} hint={`${fmtInt(data.totals.failures)} failures`} />
                        <StatCard label="Projects" value={fmtInt(memberProjects.length)} hint="current memberships" />
                        <StatCard label="Models allowed" value={fmtInt(allowedModelIds.size)} hint={`of ${fmtInt((data.models ?? []).length)} active`} />
                    </div>

                    <div className="mb-4 grid gap-4 lg:grid-cols-2">
                        <Card>
                            <div className="mb-2 text-sm font-medium text-ink">Spend by project</div>
                            {donutData.length
                                ? <SpendDonut data={donutData} height={220} />
                                : <div className="grid h-[220px] place-items-center text-xs text-ink-3">No settled spend yet</div>}
                        </Card>
                        <Card>
                            <div className="mb-2 text-sm font-medium text-ink">Personal budgets</div>
                            {data.quotas.length ? (
                                <div className="space-y-3">
                                    {data.quotas.map((q) => (
                                        <div key={q.id}>
                                            <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                                                <span className="truncate text-ink-2">
                                                    {q.project_name || 'All projects'} · {q.model_name || 'All models'} · {q.window}
                                                    {q.policy === 'soft' ? ' · soft' : ''}
                                                </span>
                                                <span className="shrink-0 font-mono tabular-nums text-ink-3">
                                                    {quotaAmount(q.type, q.used + q.reserved)} / {quotaAmount(q.type, q.hard_limit)}
                                                </span>
                                            </div>
                                            <ProgressBar value={q.used + q.reserved} max={q.hard_limit} />
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="grid h-[220px] place-items-center text-center text-xs text-ink-3">
                                    No budgets scoped to this user — only project-wide pools apply. Manage them on the Budgets page.
                                </div>
                            )}
                        </Card>
                    </div>

                    <div className="space-y-4">
                        {projects.length === 0 && (
                            <Card className="text-sm text-ink-2">This user is not in any project yet.</Card>
                        )}
                        {projects.map((p) => (
                            <Card key={p.id}>
                                <div className="mb-3 flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-medium text-ink">{p.name}</span>
                                    {p.paused && <Badge tone="amber">paused</Badge>}
                                    {p.archived && <Badge tone="zinc">archived</Badge>}
                                    {!p.member && <Badge tone="zinc">no longer a member</Badge>}
                                    <span className="ml-auto font-mono text-xs tabular-nums text-ink-2">
                                        {fmtUsd(p.cost_usd)} · {fmtInt(p.generations)} generations
                                    </span>
                                </div>
                                {p.member && (
                                    <div className="flex flex-wrap gap-1.5">
                                        {p.access.map((a) => {
                                            const model = (data.models ?? []).find((m) => m.id === a.model_id);
                                            const rule = RULES[a.rule] || RULES.deny_default;
                                            return (
                                                <span key={a.model_id} title={rule.label}
                                                    className={clsx('rounded-full border px-2 py-0.5 text-[11px] font-medium', rule.chip)}>
                                                    {model?.display_name || a.model_id}
                                                    {a.max_resolution ? ` ≤${a.max_resolution}` : ''}
                                                </span>
                                            );
                                        })}
                                    </div>
                                )}
                                {p.spend.length > 0 && (
                                    <div className="mt-3">
                                        <TopBars data={p.spend.map((s) => ({ key: s.model_name, cost_usd: s.cost_usd }))} height={Math.max(120, p.spend.length * 36)} />
                                    </div>
                                )}
                            </Card>
                        ))}
                        {projects.some((p) => p.member) && (
                            <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-3">
                                <span>How to read the chips:</span>
                                {Object.entries(RULES).map(([k, r]) => (
                                    <span key={k} className={clsx('rounded-full border px-2 py-0.5 font-medium', r.chip)}>{r.label}</span>
                                ))}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
