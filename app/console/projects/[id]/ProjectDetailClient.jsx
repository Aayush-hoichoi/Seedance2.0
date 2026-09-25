'use client';

import { useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import dynamic from 'next/dynamic';
import toast from 'react-hot-toast';
import { PageHeader, Card, Badge, Button, Modal, Field, Input, Select, DataTable, ProgressBar, EmptyState, DateRangePicker, DateTimePicker } from '../../ui.jsx';
import { useApi, sendJson, fmtUsd, fmtInt, fmtDate, monthStartIso } from '../../lib.js';
import { supportedResolutionsFor } from '../../../../lib/seedance/constants.js';
import { groupProjectBudgets, projectOverallBudget } from '../projectBudgetGroups.mjs';
import { ChevronDown, History, PauseCircle, Pencil, PlayCircle, Plus, ShieldBan, ShieldCheck, Trash2, Wallet } from 'lucide-react';

const SpendDonut = dynamic(() => import('../../charts.jsx').then((m) => m.SpendDonut), { ssr: false });
const TopBars = dynamic(() => import('../../charts.jsx').then((m) => m.TopBars), { ssr: false });

const TAB = 'rounded-lg px-3 py-1.5 text-sm text-ink-2 data-[state=active]:bg-paper-3 data-[state=active]:text-ink';
const BUDGET_TYPES = [
    ['usd', 'Dollars (USD)'], ['image_count', 'Image count'],
    ['video_seconds', 'Video seconds'], ['request_count', 'Requests'],
];

export default function ProjectDetailClient({ projectId }) {
    const [editingBudget, setEditingBudget] = useState(null);
    const [historyQuota, setHistoryQuota] = useState(null);
    // Add-budget modal target: null = closed, lockedUserId null = free member
    // choice, '' = locked to Everyone, otherwise locked to that member.
    const [addingBudget, setAddingBudget] = useState(null);
    const [lifetimeRange, setLifetimeRange] = useState({ from: '', to: '' });
    const detail = useApi(`/api/projects/${projectId}`);
    const models = useApi(`/api/models?projectId=${projectId}`);
    const usersApi = useApi('/api/admin/users');
    const viewerRole = detail.data?.role;
    const isAdmin = viewerRole === 'admin' || viewerRole === 'owner';
    const userUsageQuery = `group_by=user${isAdmin ? '&include_model_breakdown=1' : ''}`;
    const lifetimeRangeQuery = lifetimeRange.from
        ? `&from=${lifetimeRange.from}T00:00:00.000Z${lifetimeRange.to ? `&to=${lifetimeRange.to}T23:59:59.999Z` : ''}`
        : '';
    const usageByModelCurrent = useApi(`/api/projects/${projectId}/usage?group_by=model&from=${monthStartIso()}`);
    const usageByModelLifetime = useApi(`/api/projects/${projectId}/usage?group_by=model${lifetimeRangeQuery}`);
    const usageCurrent = useApi(`/api/projects/${projectId}/usage?${userUsageQuery}&from=${monthStartIso()}`);
    const usageLifetime = useApi(`/api/projects/${projectId}/usage?${userUsageQuery}${lifetimeRangeQuery}`);
    const budgetModels = useApi(isAdmin ? '/api/admin/models' : null);
    // Budget cards poll like the studio's budget pill so spend moves while
    // jobs settle. spendByUser is a separate lifetime fetch on purpose — the
    // Usage tab's date-range picker must not shift the cards' "spent" figures.
    const quotas = useApi(isAdmin
        ? `/api/admin/quotas?withUsage=1&withModelBreakdown=1&projectId=${projectId}`
        : null, { refreshInterval: 30_000 });
    const spendByUser = useApi(isAdmin ? `/api/projects/${projectId}/usage?group_by=user&include_model_breakdown=1` : null,
        { refreshInterval: 30_000 });

    if (detail.error) return <EmptyState title="Not available" hint={detail.error.message} />;
    const { project, members = [], grants = [], overrides = [] } = detail.data || {};
    if (!project) return null;
    // Models (model.grant) and Overrides (override.manage) are admin-only actions —
    // managers hold neither, so hide those tabs from them (their actions would 403).
    const refresh = () => { detail.mutate(); models.mutate(); };

    async function togglePause() {
        const r = await sendJson(`/api/projects/${projectId}`, 'PATCH', { paused: !project.paused });
        if (!r.ok) return toast.error(r.data?.message || 'Failed');
        toast.success(r.data.paused ? 'Project paused — queue held' : 'Project resumed');
        refresh();
    }

    const projectQuotas = (quotas.data?.items ?? []).filter((q) => q.project_id === project.id);
    const spendRows = spendByUser.data?.items ?? [];
    const overallBudget = projectOverallBudget({ quotas: projectQuotas, spendRows });
    const budgetGroups = groupProjectBudgets({ quotas: projectQuotas, spendRows, members });
    // Quotas store the Clerk user id; show the email humans recognize.
    const emailOf = (id) => {
        const projectMember = members.find((member) => member.user_id === id);
        if (projectMember?.email) return projectMember.email;
        return (usersApi.data?.users || usersApi.data?.items || [])
            .find((user) => (user.id || user.user_id) === id)?.email || `${id.slice(0, 12)}…`;
    };

    return (
        <div>
            <PageHeader title={project.name} subtitle={`Project #${project.id} · created ${fmtDate(project.created_at)}`}>
                {project.paused
                    ? <Button variant="primary" onClick={togglePause}><PlayCircle size={14} /> Resume queue</Button>
                    : <Button variant="outline" onClick={togglePause}><PauseCircle size={14} /> Pause queue</Button>}
            </PageHeader>

            <Tabs.Root defaultValue="members">
                <Tabs.List className="mb-4 flex gap-1 overflow-x-auto scrollbar-none border-b border-line pb-2 [&>*]:shrink-0">
                    <Tabs.Trigger value="members" className={TAB}>Members</Tabs.Trigger>
                    {isAdmin && <Tabs.Trigger value="models" className={TAB}>Models</Tabs.Trigger>}
                    {isAdmin && <Tabs.Trigger value="overrides" className={TAB}>Overrides</Tabs.Trigger>}
                    <Tabs.Trigger value="budget" className={TAB}>Budget</Tabs.Trigger>
                    <Tabs.Trigger value="usage" className={TAB}>Usage</Tabs.Trigger>
                    {isAdmin && <Tabs.Trigger value="style" className={TAB}>Style</Tabs.Trigger>}
                </Tabs.List>

                <Tabs.Content value="members">
                    <MembersTab projectId={projectId} members={members} allUsers={usersApi.data?.users || usersApi.data?.items || []} onChange={refresh} />
                </Tabs.Content>
                {isAdmin && (
                    <Tabs.Content value="models">
                        <ModelsTab projectId={projectId} grants={grants} catalog={models.data?.items ?? []} onChange={refresh} />
                    </Tabs.Content>
                )}
                {isAdmin && (
                    <Tabs.Content value="overrides">
                        <OverridesTab projectId={projectId} overrides={overrides} members={members} catalog={models.data?.items ?? []} onChange={refresh} />
                    </Tabs.Content>
                )}
                <Tabs.Content value="budget">
                    <OverallBudgetCard
                        overall={overallBudget}
                        // Without this the card reads an empty quota list as
                        // "no cap, nothing allotted" and prints it as fact —
                        // an admin could set a cap below what members hold.
                        loading={quotas.isLoading || spendByUser.isLoading}
                        isAdmin={isAdmin}
                        onSetCap={() => setAddingBudget({ lockedUserId: '', overallCap: true, label: 'Overall project budget' })}
                        onEditCap={() => setEditingBudget(overallBudget.quota)}
                        onHistory={() => setHistoryQuota(overallBudget.quota)}
                    />
                    <div className="grid gap-3 lg:grid-cols-2">
                        {budgetGroups.map((group) => (
                            <Card key={group.userId ?? 'everyone'} className="self-start">
                                <details className="group/budget">
                                    <summary className="flex cursor-pointer list-none items-start justify-between gap-3 [&::-webkit-details-marker]:hidden">
                                        <div className="min-w-0">
                                            <div className="truncate text-sm font-medium text-ink">
                                                {group.userId ? emailOf(group.userId) : 'Everyone · shared pool'}
                                            </div>
                                            <div className="mt-0.5 text-xs text-ink-3">
                                                {group.allottedUsd != null
                                                    ? <>Lifetime: <span className="font-mono tabular-nums text-ink-2">{fmtUsd(group.spentUsd)}</span> spent of <span className="font-mono tabular-nums text-ink-2">{fmtUsd(group.allottedUsd)}</span> allotted</>
                                                    : <>Lifetime: <span className="font-mono tabular-nums text-ink-2">{fmtUsd(group.spentUsd)}</span> spent</>}
                                                {group.reservedUsd > 0 ? <> + <span className="font-mono tabular-nums text-ink-2">{fmtUsd(group.reservedUsd)}</span> in flight</> : null}
                                                {' · '}{group.rows.length ? `${group.rows.length} budget${group.rows.length === 1 ? '' : 's'}` : 'no budgets'}
                                            </div>
                                            {group.allottedUsd > 0 ? (
                                                <div className="mt-1.5 max-w-56">
                                                    <ProgressBar value={group.spentUsd + group.reservedUsd} max={group.allottedUsd} />
                                                </div>
                                            ) : null}
                                        </div>
                                        <div className="flex shrink-0 items-center gap-1.5">
                                            {isAdmin ? (
                                                <Button variant="outline" size="xs"
                                                    onClick={(e) => {
                                                        // A click on the button must not toggle the <details>.
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        setAddingBudget({
                                                            lockedUserId: group.userId ?? '',
                                                            label: group.userId ? emailOf(group.userId) : 'Everyone',
                                                        });
                                                    }}>
                                                    <Plus size={13} /> Add budget
                                                </Button>
                                            ) : null}
                                            <ChevronDown size={15} aria-hidden="true"
                                                className="mt-1 text-ink-3 transition-transform group-open/budget:rotate-180" />
                                        </div>
                                    </summary>
                                {group.rows.length ? (
                                    <div className="mt-3 space-y-3">
                                        {group.rows.map((q) => {
                                            const format = q.type === 'usd' ? fmtUsd : fmtInt;
                                            const used = Number(q.used);
                                            const reserved = Number(q.reserved || 0);
                                            const remaining = Math.max(0, Number(q.hard_limit) - used - reserved);
                                            return (
                                                <div key={q.id} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
                                                    <div className="mb-1 flex items-center justify-between gap-2">
                                                        <div className="min-w-0 truncate text-xs font-medium text-ink">
                                                            {q.model_id ? (q.model_name || q.model_id) : 'All models'}
                                                            <span className="ml-1.5 font-normal text-ink-3">{q.type} · {q.window}</span>
                                                        </div>
                                                        <div className="flex shrink-0 items-center gap-1.5">
                                                            <Badge tone={q.policy === 'hard' ? 'red' : 'amber'}>{q.policy}{q.policy === 'soft' ? ` +${q.soft_overage_pct}%` : ''}</Badge>
                                                            {isAdmin ? (
                                                                <>
                                                                    <Button variant="ghost" size="xs" title="Change history" aria-label="Change history"
                                                                        onClick={() => setHistoryQuota(q)}>
                                                                        <History size={13} />
                                                                    </Button>
                                                                    <Button variant="ghost" size="xs" title="Edit budget cap" aria-label="Edit budget cap"
                                                                        onClick={() => setEditingBudget(q)}>
                                                                        <Pencil size={13} />
                                                                    </Button>
                                                                </>
                                                            ) : null}
                                                        </div>
                                                    </div>
                                                    <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                                                        <span className="text-ink-2">{format(used)} spent{reserved > 0 ? ` + ${format(reserved)} in flight` : ''}</span>
                                                        <span className="font-mono tabular-nums text-ink">{format(remaining)} left of {format(q.hard_limit)}</span>
                                                    </div>
                                                    <BudgetProgressBar quota={q} />
                                                </div>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    <div className="mt-3 rounded-md border border-dashed border-line px-3 py-2 text-xs text-ink-3">
                                        No budgets — spending is uncapped for {group.userId ? 'this member' : 'this project'}.
                                    </div>
                                )}
                                {group.unbudgeted.length ? (
                                    <div className="mt-3 space-y-3">
                                        {group.unbudgeted.map((row) => (
                                            <div key={row.model_id} className="border-t border-line pt-3">
                                                <div className="mb-1 flex items-center justify-between gap-2">
                                                    <div className="min-w-0 truncate text-xs font-medium text-ink">
                                                        {row.model_name || row.model_id}
                                                        <span className="ml-1.5 font-normal text-warn">no model budget</span>
                                                    </div>
                                                    <span className="shrink-0 text-xs text-ink-3">
                                                        {group.overallCapUsd != null ? 'within the All models budget' : 'uncapped'}
                                                    </span>
                                                </div>
                                                <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                                                    <span className="text-ink-2">{fmtUsd(row.cost_usd)} spent</span>
                                                    {group.overallCapUsd != null ? (
                                                        <span className="font-mono tabular-nums text-ink-3">of {fmtUsd(group.overallCapUsd)} shared cap</span>
                                                    ) : null}
                                                </div>
                                                <ProgressBar value={row.cost_usd} max={group.overallCapUsd ?? group.spentUsd} />
                                            </div>
                                        ))}
                                    </div>
                                ) : null}
                                {group.spendBreakdown.length ? (
                                    <div className="mt-3 rounded-md border border-line bg-paper-3 px-3 py-2.5">
                                        <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-ink-3">Lifetime spend by model</div>
                                        <div className="space-y-1">
                                            {group.spendBreakdown.map((row) => (
                                                <div key={row.model_id} className="flex items-center justify-between gap-3 text-xs">
                                                    <span className="min-w-0 truncate text-ink-2">{row.model_name || row.model_id}</span>
                                                    <span className="shrink-0 font-mono tabular-nums text-ink">{fmtUsd(row.cost_usd)}</span>
                                                </div>
                                            ))}
                                        </div>
                                        <div className="mt-1.5 flex items-center justify-between gap-3 border-t border-line pt-1.5 text-xs">
                                            <span className="text-ink-3">Total spent</span>
                                            <span className="font-mono tabular-nums text-ink">{fmtUsd(group.spentUsd)}</span>
                                        </div>
                                    </div>
                                ) : null}
                                </details>
                            </Card>
                        ))}
                        {isAdmin ? (
                            <Card className="flex min-h-32 flex-col items-center justify-center border-dashed text-center">
                                <span className="mb-3 grid size-9 place-items-center rounded-full border border-line bg-paper-3 text-ink-2">
                                    <Wallet size={17} />
                                </span>
                                <div className="text-sm font-medium text-ink">Add a budget</div>
                                <div className="mt-1 max-w-xs text-xs text-ink-3">Cap spend or usage for this project, a member, or a model.</div>
                                <Button variant="primary" className="mt-3" onClick={() => setAddingBudget({ lockedUserId: null })}>
                                    <Plus size={14} /> Add budget
                                </Button>
                            </Card>
                        ) : !budgetGroups.length ? (
                            <EmptyState title="No budgets on this project" hint="An admin can add a project, per-user, or per-model budget here." />
                        ) : null}
                    </div>
                    {addingBudget ? (
                        <AddBudgetModal
                            key={addingBudget.lockedUserId ?? 'free'}
                            project={project}
                            members={members}
                            models={budgetModels.data?.items ?? []}
                            modelsLoading={budgetModels.isLoading}
                            modelsError={budgetModels.error}
                            lockedUserId={addingBudget.lockedUserId}
                            lockedUserLabel={addingBudget.label}
                            overallCap={addingBudget.overallCap}
                            onClose={() => setAddingBudget(null)}
                            onCreated={() => {
                                setAddingBudget(null);
                                quotas.mutate();
                                spendByUser.mutate();
                            }}
                        />
                    ) : null}
                    {editingBudget ? (
                        <EditBudgetModal
                            key={editingBudget.id}
                            quota={editingBudget}
                            projectName={editingBudget.project_name || project.name}
                            userName={editingBudget.user_id ? emailOf(editingBudget.user_id) : 'Everyone'}
                            // Lowering the overall budget must not strand what
                            // members already hold; the server refuses it too.
                            allocatedUsd={editingBudget.id === overallBudget.quota?.id ? overallBudget.allocatedUsd : 0}
                            onClose={() => setEditingBudget(null)}
                            onUpdated={() => {
                                setEditingBudget(null);
                                quotas.mutate();
                            }}
                        />
                    ) : null}
                    {historyQuota ? (
                        <BudgetTimelineModal quota={historyQuota} onClose={() => setHistoryQuota(null)} />
                    ) : null}
                </Tabs.Content>
                <Tabs.Content value="usage">
                    <div className="space-y-6">
                        <UsageBreakdown
                            title="Current-month usage"
                            usage={usageCurrent.data?.items ?? []}
                            usageByModel={usageByModelCurrent.data?.items ?? []}
                            detailed={isAdmin}
                        />
                        <UsageBreakdown
                            title="Lifetime usage"
                            usage={usageLifetime.data?.items ?? []}
                            usageByModel={usageByModelLifetime.data?.items ?? []}
                            detailed={isAdmin}
                            controls={isAdmin ? (
                                <DateRangePicker
                                    from={lifetimeRange.from}
                                    to={lifetimeRange.to}
                                    onChange={setLifetimeRange}
                                    className="w-full sm:w-auto"
                                />
                            ) : null}
                        />
                    </div>
                    <div className="mt-3 flex justify-end gap-3">
                        <a className="text-xs text-accent-hi hover:underline" href={`/api/projects/${projectId}/usage?${userUsageQuery}&from=${monthStartIso()}&format=csv`}>Export current month CSV</a>
                        <a className="text-xs text-accent-hi hover:underline" href={`/api/projects/${projectId}/usage?${userUsageQuery}${lifetimeRangeQuery}&format=csv`}>Export lifetime CSV</a>
                    </div>
                </Tabs.Content>
                {isAdmin && (
                    <Tabs.Content value="style">
                        <StyleTab projectId={projectId} project={project} onChange={refresh} />
                    </Tabs.Content>
                )}
            </Tabs.Root>
        </div>
    );
}

// Per-project style memory. The brief is appended to every generation this
// project makes, so this editor is the one place the look is defined — the
// alternative is what the teams do today, which is hand-pasting it into each
// prompt and watching it drift.
function StyleTab({ projectId, project, onChange }) {
    const stored = project?.style ?? null;
    const [draft, setDraft] = useState(() => JSON.stringify(stored ?? EMPTY_STYLE, null, 2));
    const [saving, setSaving] = useState(false);
    const perf = useApi(`/api/projects/${projectId}/style-performance`);

    const save = async (value) => {
        setSaving(true);
        const res = await sendJson(`/api/projects/${projectId}`, 'PATCH', { style: value });
        setSaving(false);
        if (!res.ok) {
            // styleError's messages are written for this toast — they name the
            // look and what is wrong with it.
            toast.error(res.data?.message || res.data?.error || 'Could not save the style.');
            return;
        }
        toast.success(value === null ? 'Project style cleared.' : `Project style saved as v${res.data?.style?.version ?? '?'}.`);
        if (value === null) setDraft(JSON.stringify(EMPTY_STYLE, null, 2));
        onChange?.();
        perf.mutate?.();
    };

    let parsed = null;
    let parseError = null;
    try { parsed = JSON.parse(draft); } catch (error) { parseError = error.message; }

    return (
        <div className="space-y-6">
            <Card>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <h3 className="text-sm font-semibold text-ink">Style memory</h3>
                        <p className="mt-1 max-w-2xl text-xs text-ink-2">
                            Applied automatically to every generation in this project — studio, MCP and API alike.
                            Each look is a brief; the default look applies unless someone picks another.
                            Characters are injected only when a prompt names them.
                            {stored ? ` Currently v${stored.version ?? 1}.` : ' Not set — this project has no style.'}
                        </p>
                    </div>
                    <div className="flex gap-2">
                        {stored && (
                            <Button variant="outline" disabled={saving} onClick={() => { if (confirm('Clear this project\'s style? New generations will no longer be styled.')) save(null); }}>
                                Clear style
                            </Button>
                        )}
                        <Button variant="primary" disabled={saving || !!parseError} onClick={() => save(parsed)}>
                            {saving ? 'Saving…' : 'Save style'}
                        </Button>
                    </div>
                </div>
                <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    spellCheck={false}
                    rows={22}
                    className="w-full rounded-lg border border-line bg-paper-2 p-3 font-mono text-xs text-ink outline-none focus:border-accent"
                />
                {parseError
                    ? <p className="mt-2 text-xs text-danger">Not valid JSON — {parseError}</p>
                    : <p className="mt-2 text-xs text-ink-2">{(parsed?.looks ? Object.keys(parsed.looks).length : 0)} look(s), {(parsed?.characters ? Object.keys(parsed.characters).length : 0)} character(s). The version number is assigned on save.</p>}
            </Card>

            <Card>
                <h3 className="mb-1 text-sm font-semibold text-ink">Is it working?</h3>
                <p className="mb-3 text-xs text-ink-2">
                    Like rate per style version, against this project&apos;s unstyled baseline. If a version is not beating the baseline, the brief is the problem — not the model.
                </p>
                <DataTable
                    searchable={false}
                    columns={[
                        {
                            accessorKey: 'label',
                            header: 'Cohort',
                            cell: ({ row }) => (row.original.baseline
                                ? <span className="text-ink-2">No style (baseline)</span>
                                : <span className="text-ink">{row.original.label}</span>),
                        },
                        { accessorKey: 'generations', header: 'Generations', cell: ({ getValue }) => <span className="font-mono text-ink-3">{fmtInt(getValue())}</span> },
                        { accessorKey: 'liked', header: 'Liked', cell: ({ getValue }) => <span className="font-mono text-ink-3">{fmtInt(getValue())}</span> },
                        {
                            accessorKey: 'like_rate',
                            header: 'Like rate',
                            cell: ({ row }) => {
                                const { like_rate: rate, baseline } = row.original;
                                const base = perf.data?.baselineLikeRate;
                                // Only meaningful against the project's own history.
                                const delta = baseline || base == null ? null : rate - base;
                                return (
                                    <span className="font-mono">
                                        <span className="text-ink">{(rate * 100).toFixed(1)}%</span>
                                        {delta == null ? null : (
                                            <span className={delta >= 0 ? 'ml-2 text-ok' : 'ml-2 text-danger'}>
                                                {delta >= 0 ? '+' : ''}{(delta * 100).toFixed(1)}
                                            </span>
                                        )}
                                    </span>
                                );
                            },
                        },
                    ]}
                    data={(perf.data?.items ?? []).map((row) => ({
                        ...row,
                        baseline: row.style_look == null,
                        label: `${row.style_look} · v${row.style_version ?? '?'}`,
                    }))}
                    empty="No generations yet — numbers appear once this project generates something."
                />
            </Card>
        </div>
    );
}

const EMPTY_STYLE = {
    enabled: true,
    defaultLook: 'default',
    looks: { default: { name: 'Default look', brief: '', negatives: '' } },
    characters: {},
};

function UsageBreakdown({ title, usage, usageByModel, detailed, controls = null }) {
    return (
        <section>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-ink">{title}</h2>
                {controls}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                    <div className="mb-2 text-sm font-medium text-ink-2">
                        Per-user spend
                        {detailed ? <span className="ml-1 text-xs font-normal text-ink-3">· Hover a bar for model breakdown</span> : null}
                    </div>
                    {usage.length
                        ? <TopBars data={usage} detailed={detailed} />
                        : <div className="grid h-[200px] place-items-center text-xs text-ink-3">No usage yet</div>}
                </Card>
                <Card>
                    <div className="mb-2 text-sm font-medium text-ink-2">Per-model spend</div>
                    {usageByModel.length
                        ? <SpendDonut data={usageByModel} />
                        : <div className="grid h-[200px] place-items-center text-xs text-ink-3">No usage yet</div>}
                </Card>
            </div>
        </section>
    );
}

// The project ceiling: every member and every model, lifetime. Optional — with
// no cap the project is uncapped and this card just tracks what it has spent.
function OverallBudgetCard({ overall, loading = false, isAdmin, onSetCap, onEditCap, onHistory }) {
    const { quota, capUsd, spentUsd, reservedUsd, allocatedUsd } = overall;
    const committed = spentUsd + reservedUsd;
    const uncapped = capUsd == null;
    const overAllotted = !loading && !uncapped && allocatedUsd > capUsd;
    // Until the budgets land, every figure here would be a zero invented from
    // an empty list — "no cap, $0.00 allotted" reads as fact. Show nothing
    // instead, and hold the actions: a cap must never be set against a total
    // that has not loaded.
    const value = (text) => (loading ? '—' : text);
    return (
        <Card className="mb-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="grid size-7 place-items-center rounded-full border border-line bg-paper-3 text-ink-2">
                            <Wallet size={14} />
                        </span>
                        <span className="text-sm font-medium text-ink">Overall project budget</span>
                        {loading
                            ? <Badge tone="zinc">loading…</Badge>
                            : <Badge tone={uncapped ? 'amber' : 'green'}>{uncapped ? 'no cap' : 'capped'}</Badge>}
                        {loading || uncapped ? null : (
                            <Badge tone={quota.policy === 'hard' ? 'red' : 'amber'}>
                                {quota.policy}{quota.policy === 'soft' ? ` +${quota.soft_overage_pct}%` : ''}
                            </Badge>
                        )}
                    </div>
                    <div className="mt-1 text-xs text-ink-3">
                        Every member and every model, lifetime.{' '}
                        {loading
                            ? 'Checking this project’s budgets…'
                            : uncapped
                                ? 'No cap set — spending is unlimited and only tracked here.'
                                : quota.policy === 'hard'
                                    ? 'Member budgets are carved out of this cap, and requests are rejected once it is reached.'
                                    : `Member budgets are carved out of this cap, and spending may run up to ${quota.soft_overage_pct}% past it.`}
                    </div>
                </div>
                {isAdmin ? (
                    <div className="flex shrink-0 items-center gap-1.5">
                        {loading || uncapped ? null : (
                            <Button variant="ghost" size="xs" title="Change history" aria-label="Change history" onClick={onHistory}>
                                <History size={13} />
                            </Button>
                        )}
                        <Button variant={uncapped && !loading ? 'primary' : 'outline'} size="xs" disabled={loading}
                            onClick={uncapped ? onSetCap : onEditCap}>
                            {uncapped ? <><Plus size={13} /> Set overall cap</> : <><Pencil size={13} /> Edit cap</>}
                        </Button>
                    </div>
                ) : null}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <BudgetCardValue label="Total spent" value={value(fmtUsd(spentUsd))}
                    hint={!loading && reservedUsd > 0 ? `+ ${fmtUsd(reservedUsd)} in flight` : null} />
                <BudgetCardValue label="Overall cap" value={value(uncapped ? 'No cap' : fmtUsd(capUsd))}
                    hint={!loading && uncapped ? 'unlimited' : null} />
                <BudgetCardValue label="Allotted to members" value={value(fmtUsd(allocatedUsd))}
                    hint={!loading && !uncapped ? `${fmtUsd(Math.max(0, capUsd - allocatedUsd))} unallotted` : null} />
                <BudgetCardValue label="Remaining" value={value(uncapped ? '—' : fmtUsd(Math.max(0, capUsd - committed)))} />
            </div>

            {loading || uncapped ? null : <div className="mt-3"><ProgressBar value={committed} max={capUsd} /></div>}
            {overAllotted ? (
                <div className="mt-2 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
                    Members are allotted {fmtUsd(allocatedUsd)} — more than the {fmtUsd(capUsd)} overall cap. Existing
                    budgets are never clawed back, but no member budget can grow until the overall cap is raised.
                </div>
            ) : null}
        </Card>
    );
}

function BudgetCardValue({ label, value, hint }) {
    return (
        <div className="min-w-0">
            <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-ink-3">{label}</div>
            <div className="mt-1 truncate text-xs font-medium text-ink" title={value}>{value}</div>
            {hint ? <div className="mt-0.5 truncate text-[10px] text-ink-3" title={hint}>{hint}</div> : null}
        </div>
    );
}

function BudgetTimelineModal({ quota, onClose }) {
    const history = useApi(`/api/admin/quotas?historyFor=${quota.id}`);
    const format = quota.type === 'usd' ? fmtUsd : fmtInt;
    const LABELS = {
        'quota.create': 'Created', 'quota.top_up': 'Topped up',
        'quota.cap_changed': 'Cap changed', 'quota.rescope': 'Scope changed',
        'quota.delete': 'Deleted',
    };
    return (
        <Modal open onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }} title="Budget timeline"
            footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
            {history.isLoading ? <div className="text-xs text-ink-3">Loading history…</div>
                : history.error ? <div className="text-xs text-danger">Could not load history.</div>
                    : !(history.data?.items ?? []).length
                        ? <div className="text-xs text-ink-3">No recorded changes — history only covers changes made after change-logging was deployed.</div>
                        : (
                            <ol className="max-h-96 space-y-3 overflow-y-auto border-l border-line pl-4">
                                {history.data.items.map((entry, index) => {
                                    const prev = entry.before?.hard_limit;
                                    const next = entry.after?.hard_limit;
                                    return (
                                        <li key={index} className="text-xs">
                                            <div className="text-ink-3">{new Date(entry.created_at).toLocaleString()} · {entry.actor_email || entry.actor_id}</div>
                                            <div className="text-ink-2">
                                                <span className="font-medium text-ink">{LABELS[entry.action] || entry.action}</span>
                                                {prev != null || next != null ? (
                                                    <> · {prev != null ? format(prev) : '—'} → {next != null ? format(next) : 'removed'}</>
                                                ) : null}
                                                {entry.before?.policy && entry.after?.policy && entry.before.policy !== entry.after.policy
                                                    ? <> · policy: {entry.before.policy} → {entry.after.policy}</> : null}
                                                {entry.action === 'quota.rescope' ? <> · model scope: {entry.before?.model_id || 'all'} → {entry.after?.model_id || 'all'}</> : null}
                                                {entry.reason ? <> · “{entry.reason}”</> : null}
                                            </div>
                                        </li>
                                    );
                                })}
                            </ol>
                        )}
        </Modal>
    );
}

// allocatedUsd > 0 only for the overall project budget: it may never drop below
// the member budgets carved out of it, on top of the usual spent + in-flight floor.
function EditBudgetModal({ quota, projectName, userName, allocatedUsd = 0, onClose, onUpdated }) {
    const format = quota.type === 'usd' ? fmtUsd : fmtInt;
    const wholeNumber = quota.type === 'image_count' || quota.type === 'request_count';
    const [snapshot, setSnapshot] = useState({
        hardLimit: Number(quota.hard_limit),
        used: Number(quota.used || 0),
        reserved: Number(quota.reserved || 0),
    });
    const [newCapInput, setNewCapInput] = useState(String(quota.hard_limit));
    const [policy, setPolicy] = useState(quota.policy);
    // `|| 5`, not `?? 5`: hard budgets created by a budget-request approval
    // store 0, and 0 is not a usable starting point if the admin switches this
    // budget to soft — the overage field only accepts 1–50.
    const [softOveragePct, setSoftOveragePct] = useState(Number(quota.soft_overage_pct) || 5);
    const [reason, setReason] = useState('');
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [error, setError] = useState('');

    const newCap = Number(newCapInput);
    const spentFloor = snapshot.used + snapshot.reserved;
    const minimumCap = Math.max(spentFloor, allocatedUsd);
    const unusedAllowance = Math.max(0, snapshot.hardLimit - minimumCap);
    const delta = newCap - snapshot.hardLimit;
    const reducing = Number.isFinite(newCap) && delta < 0;
    const validNumber = Number.isFinite(newCap) && newCap >= 0 && (!wholeNumber || Number.isInteger(newCap));
    const validOveragePct = policy !== 'soft'
        || (Number.isInteger(softOveragePct) && softOveragePct >= 1 && softOveragePct <= 50);
    const policyChanged = policy !== quota.policy
        || (policy === 'soft' && softOveragePct !== (Number(quota.soft_overage_pct) || 5));
    const valid = validNumber
        && validOveragePct
        && newCap >= minimumCap
        && (newCap !== snapshot.hardLimit || policyChanged)
        && (!reducing || reason.trim().length >= 3);

    async function save() {
        if (!valid || saving) return;
        setSaving(true);
        setError('');
        const response = await sendJson('/api/admin/quotas', 'PATCH', {
            id: quota.id,
            newHardLimit: newCap,
            expectedHardLimit: snapshot.hardLimit,
            newPolicy: policy,
            newSoftOveragePct: softOveragePct,
            reason: reason.trim() || null,
        });
        setSaving(false);

        if (!response.ok) {
            const data = response.data || {};
            if (data.code === 'BUDGET_CONFLICT' || data.code === 'BUDGET_CAP_TOO_LOW') {
                setSnapshot({
                    hardLimit: Number(data.currentHardLimit ?? snapshot.hardLimit),
                    used: Number(data.used ?? snapshot.used),
                    reserved: Number(data.reserved ?? snapshot.reserved),
                });
            }
            setError(data.message || 'Failed to update budget');
            return;
        }

        toast.success(reducing ? 'Budget cap reduced' : newCap === snapshot.hardLimit ? 'Budget policy updated' : 'Budget cap updated');
        onUpdated();
    }

    async function remove() {
        setDeleting(true);
        setError('');
        const response = await sendJson(`/api/admin/quotas?id=${quota.id}`, 'DELETE');
        setDeleting(false);
        if (!response.ok) {
            setError(response.data?.message || 'Failed to delete budget');
            return;
        }
        toast.success('Budget deleted — unused allowance was not spent');
        onUpdated();
    }

    const validationMessage = !newCapInput
        ? 'Enter a new cap.'
        : !validNumber
            ? wholeNumber ? 'This budget requires a non-negative whole number.' : 'Enter zero or a positive number.'
            : newCap < minimumCap
                ? allocatedUsd > spentFloor
                    ? `The overall budget cannot be below ${format(allocatedUsd)} already allotted to members. Reduce their budgets first.`
                    : `The cap cannot be below ${format(minimumCap)} (spent plus in-flight usage).`
                : !validOveragePct
                    ? 'The soft overage must be a whole number between 1 and 50 percent.'
                    : newCap === snapshot.hardLimit && !policyChanged
                        ? 'Change the cap or the policy.'
                        : reducing && reason.trim().length < 3
                            ? 'Add a short reason for reducing this budget.'
                            : '';

    return (
        <Modal open onOpenChange={(nextOpen) => { if (!nextOpen && !saving && !deleting) onClose(); }} title={confirmDelete ? 'Delete this budget?' : 'Edit budget cap'}
            footer={<>
                {confirmDelete ? <>
                    <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={deleting}>Keep budget</Button>
                    <Button variant="danger" onClick={remove} loading={deleting}>Delete budget</Button>
                </> : <>
                    <Button variant="danger" className="sm:mr-auto" onClick={() => setConfirmDelete(true)} disabled={saving}>
                        <Trash2 size={13} /> Delete budget
                    </Button>
                    <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
                    <Button variant={reducing ? 'danger' : 'primary'} onClick={save} loading={saving} disabled={!valid}>
                        {reducing ? 'Reduce budget' : 'Save cap'}
                    </Button>
                </>}
            </>}>
            <Card className="bg-paper-3">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <BudgetCardValue label="Project" value={projectName} />
                    <BudgetCardValue label="User" value={userName} />
                    <BudgetCardValue label="Spent" value={format(snapshot.used)} />
                    <BudgetCardValue label="In flight" value={format(snapshot.reserved)} />
                    <BudgetCardValue label="Current cap" value={format(snapshot.hardLimit)} />
                    <BudgetCardValue label="Minimum safe cap" value={format(minimumCap)}
                        hint={allocatedUsd > spentFloor ? `${format(allocatedUsd)} allotted to members` : null} />
                </div>
            </Card>

            {confirmDelete ? (
                <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-3 text-xs leading-relaxed text-ink-2">
                    <div className="font-medium text-danger">This removes only the spending cap.</div>
                    <p className="mt-1">
                        The unused allowance of <span className="font-mono font-semibold text-ink">{format(unusedAllowance)}</span> is not charged or wasted.
                        Existing spend history remains unchanged. After deletion, this user falls back to any broader project or workspace budget; if none exists, this specific cap no longer restricts them.
                    </p>
                </div>
            ) : <>

            <Field label="New total budget cap">
                <Input type="number" min={minimumCap} step={wholeNumber ? '1' : 'any'} value={newCapInput}
                    onChange={(event) => { setNewCapInput(event.target.value); setError(''); }}
                    onKeyDown={(event) => { if (event.key === 'Enter') save(); }} />
            </Field>

            <Field label="Policy">
                <Select className="w-full" value={policy}
                    onChange={(event) => { setPolicy(event.target.value); setError(''); }}>
                    <option value="hard">hard — reject at limit</option>
                    <option value="soft">soft — allow small overage</option>
                </Select>
            </Field>

            {policy === 'soft' ? (
                <Field label="Overage % — how far past the cap spending may go">
                    <Input type="number" min="1" max="50" step="1" value={softOveragePct}
                        onChange={(event) => { setSoftOveragePct(Number(event.target.value)); setError(''); }} />
                </Field>
            ) : null}

            {validNumber && newCap >= minimumCap && newCap !== snapshot.hardLimit ? (
                <div className={`rounded-md border px-3 py-2 text-xs ${reducing ? 'border-danger/30 bg-danger/10 text-danger' : 'border-line bg-paper-2 text-ink-2'}`}>
                    {reducing
                        ? `This removes ${format(Math.abs(delta))} of unused allowance. The new available balance will be ${format(newCap - minimumCap)}.`
                        : `This adds ${format(delta)}. The new available balance will be ${format(newCap - minimumCap)}.`}
                </div>
            ) : null}

            {reducing ? (
                <Field label="Reason for reduction">
                    <Input value={reason} maxLength={500} placeholder="Correcting an accidental allocation"
                        onChange={(event) => { setReason(event.target.value); setError(''); }}
                        onKeyDown={(event) => { if (event.key === 'Enter') save(); }} />
                </Field>
            ) : null}
            </>}

            {error ? <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div> : null}
            {!confirmDelete && !error && validationMessage ? <div className="text-xs text-ink-3">{validationMessage}</div> : null}
        </Modal>
    );
}

// lockedUserId: null = free member choice, '' = locked to Everyone, otherwise
// locked to that member — the per-user budget cards open this with their user
// pinned so "Add budget" always lands on the right person.
// overallCap: opened from the overall-budget card, so the scope that defines
// that budget (everyone, all models, USD) is fixed and only the amount is free.
function AddBudgetModal({ project, members, models, modelsLoading, modelsError, lockedUserId = null, lockedUserLabel, overallCap = false, onClose, onCreated }) {
    const [saving, setSaving] = useState(false);
    const [form, setForm] = useState({ type: 'usd', window: 'lifetime', addAmount: '', policy: 'hard', softOveragePct: 5, userId: lockedUserId || '', modelId: '' });
    const previewParams = new URLSearchParams({
        projectId: String(project.id),
        type: form.type,
        window: form.window,
        ...(form.userId ? { userId: form.userId } : {}),
        ...(form.modelId ? { modelId: form.modelId } : {}),
    });
    const preview = useApi(`/api/admin/quotas/preview?${previewParams}`);
    const previewData = preview.data;
    const previewFormat = form.type === 'usd' ? fmtUsd : fmtInt;
    const existingBudget = previewData?.existingBudget;
    const previousCap = Number(previewData?.previouslyAllotted || 0);
    const addAmount = Number(form.addAmount) || 0;
    const newCap = previousCap + addAmount;
    const effectivePolicy = existingBudget?.policy || form.policy;
    const wholeNumber = form.type === 'image_count' || form.type === 'request_count';
    // Per-user budgets must name a model; "all models" is only for the whole project.
    const needsModel = !!form.userId && !form.modelId;
    // The overall project budget and the member budgets carved out of it are
    // two sides of one rule, checked here so the admin sees the problem before
    // submitting. The POST refuses either again server-side.
    //   member budget → the amount is a delta on top of what is allotted today,
    //                   and must fit the unallotted headroom
    //   overall budget → its resulting cap must cover what members already hold
    const allocation = previewData?.overallBudget;
    const overallHeadroom = form.userId && form.type === 'usd' && allocation?.cap != null ? allocation : null;
    const exceedsOverall = !!overallHeadroom && addAmount > overallHeadroom.available;
    const belowAllocations = overallCap && allocation ? newCap < allocation.allocated : false;
    const validAddAmount = addAmount > 0 && (!wholeNumber || Number.isInteger(addAmount))
        && !needsModel && !exceedsOverall && !belowAllocations;

    async function create() {
        setSaving(true);
        const r = existingBudget
            ? await sendJson('/api/admin/quotas', 'PATCH', { id: existingBudget.id, addAmount })
            : await sendJson('/api/admin/quotas', 'POST', {
                ...form,
                hardLimit: addAmount,
                projectId: project.id,
                userId: form.userId || null,
                modelId: form.modelId || null,
            });
        setSaving(false);
        if (!r.ok) return toast.error(r.data?.message || 'Failed to add budget');
        const toppedUp = !!existingBudget || r.data?.created === false;
        toast.success(toppedUp ? 'Budget topped up' : 'Budget created — enforced on the next request');
        onCreated();
    }

    return (
        <Modal open onOpenChange={(nextOpen) => { if (!nextOpen && !saving) onClose(); }}
            title={overallCap ? 'Set the overall project budget' : `Add budget · ${lockedUserLabel || project.name}`}
                footer={<>
                    <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
                    <Button variant="primary" onClick={create} loading={saving}
                        disabled={!validAddAmount || preview.isLoading || !!preview.error}>
                        {existingBudget ? 'Add to budget' : 'Create budget'}
                    </Button>
                </>}>
                <p className="mb-3 text-xs leading-relaxed text-ink-3">
                    {overallCap
                        ? <>This caps <span className="font-medium text-ink-2">{project.name}</span> as a whole — every member, every model. Member budgets are carved out of it and can never sum past it. Leave it unset to keep the project uncapped.</>
                        : <>This budget applies to <span className="font-medium text-ink-2">{project.name}</span>. Leave member and model blank to cap the whole project. If this scope already has a budget, the amount entered below is added on top of its current cap.</>}
                </p>
                <Card className="mb-4 bg-paper-3">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        <BudgetCardValue label="Project" value={previewData?.project?.name || project.name} />
                        <BudgetCardValue
                            label="User"
                            value={previewData?.user?.email || previewData?.user?.name || (preview.isLoading ? 'Loading…' : 'Everyone')}
                        />
                        <BudgetCardValue
                            label="Spent"
                            value={previewData ? previewFormat(previewData.used) : preview.isLoading ? 'Loading…' : '—'}
                            hint={Number(previewData?.reserved) > 0 ? `+${previewFormat(previewData.reserved)} in flight` : null}
                        />
                        <BudgetCardValue
                            label="Remaining"
                            value={previewData ? previewFormat(previewData.remaining) : preview.isLoading ? 'Loading…' : '—'}
                        />
                        <BudgetCardValue
                            label="Previously allotted"
                            value={previewData ? previewFormat(previousCap) : preview.isLoading ? 'Loading…' : '—'}
                            hint={previewData ? `${previewFormat(previewData.used)} spent + ${previewFormat(previewData.remaining)} remaining` : null}
                        />
                        <BudgetCardValue label="Adding now" value={previewFormat(addAmount)} />
                        <BudgetCardValue label="New total budget" value={previewData ? previewFormat(newCap) : preview.isLoading ? 'Loading…' : '—'} />
                    </div>
                    {preview.error ? <div className="mt-2 text-xs text-danger">Could not load current spend.</div> : null}
                </Card>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Type">
                        <Select className="w-full" value={form.type} disabled={overallCap}
                            title={overallCap ? 'The overall project budget is always in dollars' : undefined}
                            onChange={(e) => setForm({ ...form, type: e.target.value })}>
                            {BUDGET_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </Select>
                    </Field>
                    <Field label="Window">
                        <Select className="w-full" value={form.window} disabled>
                            <option value="lifetime">lifetime</option>
                        </Select>
                    </Field>
                    <Field label={existingBudget ? 'Amount to add' : 'Initial budget amount'}>
                        <Input
                            type="number"
                            min="0"
                            step={wholeNumber ? '1' : 'any'}
                            value={form.addAmount}
                            onChange={(e) => setForm({ ...form, addAmount: e.target.value })}
                            placeholder={form.type === 'usd' ? '100' : '50'}
                        />
                    </Field>
                    <Field label="Policy">
                        <Select className="w-full" value={effectivePolicy} disabled={!!existingBudget}
                            title={existingBudget ? 'An existing budget keeps its current policy' : undefined}
                            onChange={(e) => setForm({ ...form, policy: e.target.value })}>
                            <option value="hard">hard — reject at limit</option>
                            <option value="soft">soft — allow small overage</option>
                        </Select>
                    </Field>
                    <Field label="Member (blank = everyone)">
                        <Select className="w-full" value={form.userId} disabled={lockedUserId != null}
                            title={lockedUserId != null ? 'This card adds budget for a fixed scope' : undefined}
                            onChange={(e) => setForm({ ...form, userId: e.target.value })}>
                            <option value="">—</option>
                            {lockedUserId && !members.some((m) => m.user_id === lockedUserId)
                                ? <option value={lockedUserId}>{lockedUserLabel || lockedUserId}</option> : null}
                            {members.map((member) => <option key={member.user_id} value={member.user_id}>{member.email || member.name || member.user_id}</option>)}
                        </Select>
                    </Field>
                    <Field label={form.userId ? 'Model (required for member budgets)' : 'Model (blank = all models)'}>
                        <Select className="w-full" value={form.modelId} disabled={overallCap || !models.length}
                            title={overallCap ? 'The overall project budget covers every model' : undefined}
                            onChange={(e) => setForm({ ...form, modelId: e.target.value })}>
                            <option value="">{modelsError ? 'Could not load models' : modelsLoading ? 'Loading models…' : form.userId ? 'Select a model…' : '—'}</option>
                            {models.map((model) => <option key={model.id} value={model.id}>{model.display_name} · {model.category}</option>)}
                        </Select>
                    </Field>
                </div>
                {needsModel ? (
                    <div className="mt-3 text-xs text-ink-3">Pick a model — member budgets can no longer cover all models at once.</div>
                ) : null}
                {belowAllocations ? (
                    <div className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger">
                        Members of this project are already allotted {fmtUsd(allocation.allocated)}. The overall budget has to
                        be at least that much — {fmtUsd(newCap)} would strand budgets that are already in use. Set{' '}
                        {fmtUsd(allocation.allocated)} or more, or reduce the member budgets first.
                    </div>
                ) : overallCap && allocation?.allocated > 0 ? (
                    <div className="mt-3 text-xs text-ink-3">
                        Members are already allotted {fmtUsd(allocation.allocated)} — the overall budget cannot be set below that.
                    </div>
                ) : null}
                {exceedsOverall ? (
                    <div className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger">
                        This exceeds the project&rsquo;s overall budget of {fmtUsd(overallHeadroom.cap)}. Members are already
                        allotted {fmtUsd(overallHeadroom.allocated)}, leaving {fmtUsd(overallHeadroom.available)} to hand out.
                        Raise the overall budget first, or add {fmtUsd(overallHeadroom.available)} or less.
                    </div>
                ) : overallHeadroom ? (
                    <div className="mt-3 text-xs text-ink-3">
                        {fmtUsd(overallHeadroom.available)} of the {fmtUsd(overallHeadroom.cap)} overall project budget is still unallotted.
                    </div>
                ) : null}
                {effectivePolicy === 'soft' && !existingBudget ? (
                    <Field label="Overage % — how far past the limit the budget may go">
                        <Input
                            type="number"
                            min="1"
                            max="50"
                            value={form.softOveragePct}
                            onChange={(e) => setForm({ ...form, softOveragePct: Number(e.target.value) })}
                        />
                    </Field>
                ) : null}
        </Modal>
    );
}

function BudgetProgressBar({ quota }) {
    const rows = quota.model_breakdown ?? [];
    const tooltipId = `budget-${quota.id}-model-breakdown`;
    const format = quota.type === 'usd' ? fmtUsd : fmtInt;

    return (
        <div
            className="group relative -my-1 cursor-help py-1 outline-none"
            tabIndex={0}
            aria-describedby={tooltipId}
            aria-label="Budget usage. Hover or focus for spending by model."
        >
            <ProgressBar value={Number(quota.used) + Number(quota.reserved || 0)} max={Number(quota.hard_limit)} />
            <div
                id={tooltipId}
                role="tooltip"
                className="pointer-events-none invisible absolute bottom-full left-1/2 z-50 mb-2 w-72 -translate-x-1/2 rounded-lg border border-line bg-paper-1 p-3 opacity-0 shadow-xl transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
            >
                <div className="mb-2 text-xs font-medium text-ink">Spent by model · {quota.window}</div>
                {rows.length ? (
                    <div className="space-y-1.5">
                        {rows.map((row) => (
                            <div key={row.model_id} className="flex items-start justify-between gap-3 text-xs">
                                <span className="min-w-0 truncate text-ink-2">{row.model_name || row.model_id}</span>
                                <span className="shrink-0 text-right font-mono tabular-nums text-ink">
                                    {format(row.used)}
                                    {Number(row.reserved) > 0
                                        ? <span className="block text-[10px] text-ink-3">+{format(row.reserved)} in flight</span>
                                        : null}
                                </span>
                            </div>
                        ))}
                    </div>
                ) : <div className="text-xs text-ink-3">No model spend in this budget window.</div>}
                <div className="mt-2 flex justify-between border-t border-line pt-2 text-xs">
                    <span className="text-ink-3">Total spent</span>
                    <span className="font-mono tabular-nums text-ink">{format(quota.used)}</span>
                </div>
            </div>
        </div>
    );
}

function MembersTab({ projectId, members, allUsers, onChange }) {
    const [open, setOpen] = useState(false);
    const [userId, setUserId] = useState('');
    const [query, setQuery] = useState('');
    const [toRemove, setToRemove] = useState(null);
    const [removing, setRemoving] = useState(false);

    // Roles are platform-level (set on the Users console), NOT per-project. The
    // Role column shows each member's platform role, read-only. Adding a member
    // just records that they belong to this project; it never sets a role.
    async function add() {
        const r = await sendJson(`/api/projects/${projectId}/members`, 'POST', { userId });
        if (!r.ok) return toast.error(r.data?.message || 'Failed');
        toast.success('Member added');
        setOpen(false); setUserId(''); setQuery(''); onChange();
    }
    async function remove() {
        if (!toRemove) return;
        setRemoving(true);
        const r = await sendJson(`/api/projects/${projectId}/members?userId=${encodeURIComponent(toRemove.user_id)}`, 'DELETE');
        setRemoving(false);
        if (!r.ok) return toast.error(r.data?.message || 'Failed');
        toast.success('Member removed');
        setToRemove(null);
        onChange();
    }

    const candidates = allUsers.filter((u) => !members.some((m) => m.user_id === (u.id || u.user_id)));
    const filterUsers = (text) => {
        const q = text.trim().toLowerCase();
        if (!q) return candidates;
        return candidates.filter((u) => [u.email, u.name, u.id || u.user_id].some((v) => v && String(v).toLowerCase().includes(q)));
    };
    const matches = filterUsers(query);
    const columns = [
        { accessorKey: 'email', header: 'User', cell: ({ row }) => <span className="text-ink">{row.original.email || row.original.name || row.original.user_id}</span> },
        { accessorKey: 'created_at', header: 'Added', cell: ({ getValue }) => <span className="font-mono text-ink-3">{fmtDate(getValue())}</span> },
        {
            id: 'actions', header: '', enableSorting: false,
            cell: ({ row }) => <Button variant="ghost" size="xs" title="Remove member" onClick={() => setToRemove(row.original)}><Trash2 size={13} className="text-danger" /></Button>,
        },
    ];
    return (
        <div>
            <div className="mb-3 flex justify-end">
                <Button variant="primary" size="sm" onClick={() => setOpen(true)}><Plus size={14} /> Add member</Button>
            </div>
            <DataTable columns={columns} data={members} empty="No members yet." />
            <Modal open={!!toRemove} onOpenChange={(nextOpen) => { if (!nextOpen && !removing) setToRemove(null); }}
                title={`Remove ${toRemove?.email || toRemove?.name || 'this member'}?`}
                footer={<>
                    <Button variant="outline" onClick={() => setToRemove(null)} disabled={removing}>Cancel</Button>
                    <Button variant="danger" onClick={remove} loading={removing}>Remove member</Button>
                </>}>
                <p className="text-sm text-ink-2">
                    This person will lose access to the project. Their existing usage history will be kept.
                </p>
            </Modal>
            <Modal open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (!nextOpen) { setUserId(''); setQuery(''); } }} title="Add member"
                footer={<>
                    <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                    <Button variant="primary" onClick={add} disabled={!userId}>Add</Button>
                </>}>
                <Field label="User">
                    <Input className="w-full" placeholder="Type a name or email to search…" value={query} autoFocus
                        onChange={(e) => {
                            setQuery(e.target.value);
                            // Keep the selection consistent with what's visible: drop it if
                            // filtered out, auto-pick when the search narrows to one user.
                            const nm = filterUsers(e.target.value);
                            if (nm.length === 1) setUserId(nm[0].id || nm[0].user_id);
                            else if (userId && !nm.some((u) => (u.id || u.user_id) === userId)) setUserId('');
                        }} />
                    {/* Results render as a visible list, not a click-to-open dropdown:
                        typing must immediately show the matching users. */}
                    <div className="mt-2 max-h-56 divide-y divide-line overflow-y-auto rounded-md border border-line">
                        {matches.length === 0 && (
                            <div className="px-3 py-2 text-sm text-ink-3">No users match your search.</div>
                        )}
                        {matches.map((u) => {
                            const id = u.id || u.user_id;
                            const selected = id === userId;
                            return (
                                <button key={id} type="button" onClick={() => setUserId(selected ? '' : id)}
                                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${selected ? 'bg-paper-3 text-ink' : 'text-ink-2 hover:bg-paper-3'}`}>
                                    <span>{u.email || u.name || id}</span>
                                    {selected && <span className="text-xs text-ink-3">selected</span>}
                                </button>
                            );
                        })}
                    </div>
                </Field>
            </Modal>
        </div>
    );
}

function ModelsTab({ projectId, grants, catalog, onChange }) {
    const [expiry, setExpiry] = useState({}); // modelId → datetime-local value
    const [toRevoke, setToRevoke] = useState(null); // modelId pending confirm
    const [revoking, setRevoking] = useState(false);

    async function grant(modelId) {
        const validUntil = expiry[modelId] ? new Date(expiry[modelId]).toISOString() : null;
        const r = await sendJson(`/api/projects/${projectId}/models`, 'POST', { modelId, validUntil });
        r.ok ? (toast.success(`Granted ${modelId}${validUntil ? ' (time-boxed)' : ''}`), onChange()) : toast.error(r.data?.message || 'Failed');
    }
    async function revoke() {
        if (!toRevoke) return;
        setRevoking(true);
        const r = await sendJson(`/api/projects/${projectId}/models?modelId=${encodeURIComponent(toRevoke)}`, 'DELETE');
        setRevoking(false);
        if (!r.ok) return toast.error(r.data?.message || 'Failed');
        toast.success(`Revoked ${toRevoke} — queued jobs cancelled`);
        setToRevoke(null);
        onChange();
    }

    return (
        <div className="grid gap-3 lg:grid-cols-2">
            <Modal open={!!toRevoke} onOpenChange={(v) => { if (!v) setToRevoke(null); }}
                title={`Revoke ${toRevoke} for the whole project?`}
                footer={<>
                    <Button variant="outline" onClick={() => setToRevoke(null)}>Cancel</Button>
                    <Button variant="danger" onClick={revoke} loading={revoking}>Revoke</Button>
                </>}>
                <p className="text-sm text-ink-2">Queued jobs for this model are cancelled immediately. Members lose access unless they hold a personal override.</p>
            </Modal>
            {catalog.map((m) => {
                const g = grants.find((x) => x.model_id === m.id);
                return (
                    <Card key={m.id}>
                        <div className="flex items-start justify-between">
                            <div>
                                <div className="text-sm font-medium text-ink">{m.displayName}</div>
                                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-3">
                                    <Badge tone={m.category === 'video' ? 'violet' : 'blue'}>{m.category}</Badge>
                                    {m.isDefault ? <Badge tone="green">org default</Badge> : null}
                                    {g?.valid_until ? <Badge tone="amber">expires {fmtDate(g.valid_until)}</Badge> : null}
                                </div>
                            </div>
                            {g ? (
                                <Button variant="danger" size="xs" onClick={() => setToRevoke(m.id)}>Revoke</Button>
                            ) : m.isDefault ? (
                                <Badge tone="green">always on</Badge>
                            ) : (
                                <div className="flex items-end gap-1.5">
                                    <Field label="Optional expiry">
                                        <DateTimePicker className="w-44" value={expiry[m.id] || ''}
                                            onChange={(v) => setExpiry({ ...expiry, [m.id]: v })} />
                                    </Field>
                                    <Button variant="primary" size="xs" onClick={() => grant(m.id)}>Grant</Button>
                                </div>
                            )}
                        </div>
                    </Card>
                );
            })}
        </div>
    );
}

function OverridesTab({ projectId, overrides, members, catalog, onChange }) {
    const [form, setForm] = useState({ userId: '', modelId: '', effect: 'deny', maxResolution: '', validUntil: '' });
    const [toRemove, setToRemove] = useState(null);
    const [removing, setRemoving] = useState(false);
    // Quality caps an ALLOW only — a deny grants nothing to cap. Tiers come from
    // the picked model; switching model drops a cap it no longer supports.
    const tiers = supportedResolutionsFor(form.modelId) ?? [];
    const capDisabled = form.effect !== 'allow' || !tiers.length;

    function pickModel(modelId) {
        const next = supportedResolutionsFor(modelId) ?? [];
        setForm({ ...form, modelId, maxResolution: next.includes(form.maxResolution) ? form.maxResolution : '' });
    }

    async function add() {
        const r = await sendJson(`/api/projects/${projectId}/overrides`, 'POST', {
            ...form,
            maxResolution: capDisabled ? null : (form.maxResolution || null),
            validUntil: form.validUntil ? new Date(form.validUntil).toISOString() : null,
        });
        r.ok ? (toast.success(`Override saved (${form.effect})`), onChange()) : toast.error(r.data?.message || 'Failed');
    }
    async function remove() {
        if (!toRemove) return;
        setRemoving(true);
        const r = await sendJson(`/api/projects/${projectId}/overrides?userId=${encodeURIComponent(toRemove.user_id)}&modelId=${encodeURIComponent(toRemove.model_id)}`, 'DELETE');
        setRemoving(false);
        if (!r.ok) return toast.error(r.data?.message || 'Failed');
        toast.success('Override removed');
        setToRemove(null);
        onChange();
    }

    const columns = [
        { accessorKey: 'email', header: 'User', cell: ({ row }) => row.original.email || row.original.user_id },
        { accessorKey: 'model_id', header: 'Model' },
        {
            accessorKey: 'effect', header: 'Effect',
            cell: ({ getValue }) => getValue() === 'deny'
                ? <Badge tone="red"><ShieldBan size={11} /> deny</Badge>
                : <Badge tone="green"><ShieldCheck size={11} /> allow</Badge>,
        },
        {
            accessorKey: 'max_resolution', header: 'Quality',
            cell: ({ getValue, row }) => row.original.effect !== 'allow'
                ? <span className="text-ink-3">—</span>
                : <span className="font-mono text-xs text-ink-2">{getValue() || 'full'}</span>,
        },
        { accessorKey: 'valid_until', header: 'Expires', cell: ({ getValue }) => <span className="font-mono text-ink-3">{getValue() ? fmtDate(getValue()) : 'never'}</span> },
        { id: 'actions', header: '', enableSorting: false, cell: ({ row }) => <Button variant="ghost" size="xs" title="Delete override" onClick={() => setToRemove(row.original)}><Trash2 size={13} className="text-danger" /></Button> },
    ];
    return (
        <div>
            <Card className="mb-4">
                <div className="grid items-end gap-2 sm:grid-cols-3 lg:grid-cols-6">
                    <Field label="User">
                        <Select className="w-full" value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
                            <option value="">Select…</option>
                            {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.email || m.user_id}</option>)}
                        </Select>
                    </Field>
                    <Field label="Model">
                        <Select className="w-full" value={form.modelId} onChange={(e) => pickModel(e.target.value)}>
                            <option value="">Select…</option>
                            {catalog.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
                        </Select>
                    </Field>
                    <Field label="Effect">
                        <Select className="w-full" value={form.effect} onChange={(e) => setForm({ ...form, effect: e.target.value })}>
                            <option value="deny">deny (block this user)</option>
                            <option value="allow">allow (early access)</option>
                        </Select>
                    </Field>
                    <Field label="Quality">
                        <Select className="w-full" value={form.maxResolution} disabled={capDisabled}
                            title={capDisabled ? 'Quality applies to allow overrides only' : 'Highest tier this user may request (lower tiers included)'}
                            onChange={(e) => setForm({ ...form, maxResolution: e.target.value })}>
                            <option value="">full (no cap)</option>
                            {tiers.map((t) => <option key={t} value={t}>{t}</option>)}
                        </Select>
                    </Field>
                    <Field label="Expires (optional)">
                        <DateTimePicker value={form.validUntil} onChange={(v) => setForm({ ...form, validUntil: v })} />
                    </Field>
                    <Button variant="primary" onClick={add} disabled={!form.userId || !form.modelId}>Save override</Button>
                </div>
            </Card>
            <DataTable columns={columns} data={overrides} searchable={false} empty="No user overrides — everyone follows the project grants." />
            <Modal open={!!toRemove} onOpenChange={(nextOpen) => { if (!nextOpen && !removing) setToRemove(null); }}
                title="Delete this access override?"
                footer={<>
                    <Button variant="outline" onClick={() => setToRemove(null)} disabled={removing}>Cancel</Button>
                    <Button variant="danger" onClick={remove} loading={removing}>Delete override</Button>
                </>}>
                <p className="text-sm text-ink-2">
                    The user will immediately return to the project’s normal model-access rules.
                </p>
            </Modal>
        </div>
    );
}
