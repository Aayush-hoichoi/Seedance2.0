'use client';

import { useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import dynamic from 'next/dynamic';
import toast from 'react-hot-toast';
import { PageHeader, Card, Badge, Button, Modal, Field, Input, Select, DataTable, ProgressBar, EmptyState } from '../../ui.jsx';
import { useApi, sendJson, fmtUsd, fmtInt, fmtDate, monthStartIso } from '../../lib.js';
import { PauseCircle, PlayCircle, Plus, ShieldBan, ShieldCheck, Trash2 } from 'lucide-react';

const SpendDonut = dynamic(() => import('../../charts.jsx').then((m) => m.SpendDonut), { ssr: false });
const TopBars = dynamic(() => import('../../charts.jsx').then((m) => m.TopBars), { ssr: false });

const TAB = 'rounded-lg px-3 py-1.5 text-sm text-ink-2 data-[state=active]:bg-paper-3 data-[state=active]:text-ink';

export default function ProjectDetailClient({ projectId }) {
    const detail = useApi(`/api/projects/${projectId}`);
    const models = useApi(`/api/models?projectId=${projectId}`);
    const usersApi = useApi('/api/admin/users');
    const usage = useApi(`/api/projects/${projectId}/usage?group_by=user&from=${monthStartIso()}`);
    const usageByModel = useApi(`/api/projects/${projectId}/usage?group_by=model&from=${monthStartIso()}`);
    const quotas = useApi('/api/admin/quotas?withUsage=1');

    if (detail.error) return <EmptyState title="Not available" hint={detail.error.message} />;
    const { project, role: viewerRole, members = [], grants = [], overrides = [] } = detail.data || {};
    if (!project) return null;
    // Models (model.grant) and Overrides (override.manage) are admin-only actions —
    // managers hold neither, so hide those tabs from them (their actions would 403).
    const isAdmin = viewerRole === 'admin' || viewerRole === 'owner';

    const refresh = () => { detail.mutate(); models.mutate(); };

    async function togglePause() {
        const r = await sendJson(`/api/projects/${projectId}`, 'PATCH', { paused: !project.paused });
        if (!r.ok) return toast.error(r.data?.message || 'Failed');
        toast.success(r.data.paused ? 'Project paused — queue held' : 'Project resumed');
        refresh();
    }

    const projectQuotas = (quotas.data?.items ?? []).filter((q) => q.project_id === project.id);
    // Quotas store the Clerk user id; show the email humans recognize.
    const emailOf = (id) => (usersApi.data?.users || usersApi.data?.items || []).find((u) => (u.id || u.user_id) === id)?.email || `${id.slice(0, 12)}…`;

    return (
        <div>
            <PageHeader title={project.name} subtitle={`Project #${project.id} · created ${fmtDate(project.created_at)}`}>
                {project.paused
                    ? <Button variant="primary" onClick={togglePause}><PlayCircle size={14} /> Resume queue</Button>
                    : <Button variant="outline" onClick={togglePause}><PauseCircle size={14} /> Pause queue</Button>}
            </PageHeader>

            <Tabs.Root defaultValue="members">
                <Tabs.List className="mb-4 flex gap-1 border-b border-line pb-2">
                    <Tabs.Trigger value="members" className={TAB}>Members</Tabs.Trigger>
                    {isAdmin && <Tabs.Trigger value="models" className={TAB}>Models</Tabs.Trigger>}
                    {isAdmin && <Tabs.Trigger value="overrides" className={TAB}>Overrides</Tabs.Trigger>}
                    <Tabs.Trigger value="budget" className={TAB}>Budget</Tabs.Trigger>
                    <Tabs.Trigger value="usage" className={TAB}>Usage</Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="members">
                    <MembersTab projectId={projectId} members={members} allUsers={usersApi.data?.users || usersApi.data?.items || []} canManageRoles={isAdmin} onChange={refresh} />
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
                    <div className="grid gap-3 lg:grid-cols-2">
                        {projectQuotas.length ? projectQuotas.map((q) => (
                            <Card key={q.id}>
                                <div className="mb-1 flex items-center justify-between text-sm">
                                    <span className="text-ink-2">{q.user_id ? `User ${emailOf(q.user_id)}` : 'Whole project'} · {q.type} · {q.window}</span>
                                    <Badge tone={q.policy === 'hard' ? 'red' : 'amber'}>{q.policy}{q.policy === 'soft' ? ` +${q.soft_overage_pct}%` : ''}</Badge>
                                </div>
                                <div className="mb-2 text-xs text-ink-3">
                                    {q.type === 'usd' ? fmtUsd(q.used) : fmtInt(q.used)} used{Number(q.reserved) > 0 ? ` (+${q.type === 'usd' ? fmtUsd(q.reserved) : fmtInt(q.reserved)} reserved)` : ''} of {q.type === 'usd' ? fmtUsd(q.hard_limit) : fmtInt(q.hard_limit)}
                                </div>
                                <ProgressBar value={Number(q.used) + Number(q.reserved || 0)} max={Number(q.hard_limit)} />
                            </Card>
                        )) : <EmptyState title="No budgets on this project" hint="Create project or per-user budgets under Budgets — they enforce before any job reaches a provider." />}
                    </div>
                </Tabs.Content>
                <Tabs.Content value="usage">
                    <div className="grid gap-4 lg:grid-cols-2">
                        <Card>
                            <div className="mb-2 text-sm font-medium text-ink-2">Per-user spend (this month)</div>
                            {(usage.data?.items ?? []).length ? <TopBars data={usage.data.items} /> : <div className="grid h-[200px] place-items-center text-xs text-ink-3">No usage yet</div>}
                        </Card>
                        <Card>
                            <div className="mb-2 text-sm font-medium text-ink-2">Per-model spend (this month)</div>
                            {(usageByModel.data?.items ?? []).length ? <SpendDonut data={usageByModel.data.items} /> : <div className="grid h-[200px] place-items-center text-xs text-ink-3">No usage yet</div>}
                        </Card>
                    </div>
                    <div className="mt-3 text-right">
                        <a className="text-xs text-accent-hi hover:underline" href={`/api/projects/${projectId}/usage?group_by=user&format=csv`}>Export CSV</a>
                    </div>
                </Tabs.Content>
            </Tabs.Root>
        </div>
    );
}

function MembersTab({ projectId, members, allUsers, canManageRoles, onChange }) {
    const [open, setOpen] = useState(false);
    const [userId, setUserId] = useState('');
    const [role, setRole] = useState('member');

    // Only admins/owners assign roles (canManageRoles). Managers add plain
    // members only and never reach the role Selects below, so the full set is
    // fine here — the server also rejects non-'member' roles from non-admins.
    const assignable = ['admin', 'manager', 'member', 'viewer'];
    const roleOptionsFor = (current) => (assignable.includes(current) ? assignable : [current, ...assignable]);

    async function add() {
        const r = await sendJson(`/api/projects/${projectId}/members`, 'POST', { userId, role: canManageRoles ? role : 'member' });
        if (!r.ok) return toast.error(r.data?.message || 'Failed');
        toast.success('Member saved');
        setOpen(false); onChange();
    }
    async function setMemberRole(uid, newRole) {
        const r = await sendJson(`/api/projects/${projectId}/members`, 'POST', { userId: uid, role: newRole });
        r.ok ? (toast.success('Role updated'), onChange()) : toast.error(r.data?.message || 'Failed');
    }
    async function remove(uid) {
        const r = await sendJson(`/api/projects/${projectId}/members?userId=${encodeURIComponent(uid)}`, 'DELETE');
        r.ok ? (toast.success('Member removed'), onChange()) : toast.error(r.data?.message || 'Failed');
    }

    const candidates = allUsers.filter((u) => !members.some((m) => m.user_id === (u.id || u.user_id)));
    const columns = [
        { accessorKey: 'email', header: 'User', cell: ({ row }) => <span className="text-ink">{row.original.email || row.original.name || row.original.user_id}</span> },
        {
            accessorKey: 'role', header: 'Role',
            cell: ({ row }) => (canManageRoles
                ? <Select value={row.original.role} onChange={(e) => setMemberRole(row.original.user_id, e.target.value)}>
                    {roleOptionsFor(row.original.role).map((r) => <option key={r} value={r}>{r}</option>)}
                  </Select>
                : <span className="capitalize text-ink">{row.original.role}</span>
            ),
        },
        { accessorKey: 'created_at', header: 'Added', cell: ({ getValue }) => <span className="font-mono text-ink-3">{fmtDate(getValue())}</span> },
        {
            id: 'actions', header: '', enableSorting: false,
            cell: ({ row }) => <Button variant="ghost" size="xs" onClick={() => remove(row.original.user_id)}><Trash2 size={13} className="text-danger" /></Button>,
        },
    ];
    return (
        <div>
            <div className="mb-3 flex justify-end">
                <Button variant="primary" size="sm" onClick={() => setOpen(true)}><Plus size={14} /> Add member</Button>
            </div>
            <DataTable columns={columns} data={members} empty="No members yet." />
            <Modal open={open} onOpenChange={setOpen} title="Add member"
                footer={<>
                    <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                    <Button variant="primary" onClick={add} disabled={!userId}>Add</Button>
                </>}>
                <Field label="User">
                    <Select className="w-full" value={userId} onChange={(e) => setUserId(e.target.value)}>
                        <option value="">Select a user…</option>
                        {candidates.map((u) => <option key={u.id || u.user_id} value={u.id || u.user_id}>{u.email || u.name || u.id}</option>)}
                    </Select>
                </Field>
                {canManageRoles && (
                    <Field label="Role">
                        <Select className="w-full" value={role} onChange={(e) => setRole(e.target.value)}>
                            {assignable.map((r) => <option key={r} value={r}>{r}</option>)}
                        </Select>
                    </Field>
                )}
            </Modal>
        </div>
    );
}

function ModelsTab({ projectId, grants, catalog, onChange }) {
    const [expiry, setExpiry] = useState({}); // modelId → datetime-local value

    async function grant(modelId) {
        const validUntil = expiry[modelId] ? new Date(expiry[modelId]).toISOString() : null;
        const r = await sendJson(`/api/projects/${projectId}/models`, 'POST', { modelId, validUntil });
        r.ok ? (toast.success(`Granted ${modelId}${validUntil ? ' (time-boxed)' : ''}`), onChange()) : toast.error(r.data?.message || 'Failed');
    }
    async function revoke(modelId) {
        if (!window.confirm(`Revoke ${modelId} for the whole project? Queued jobs for it are cancelled immediately.`)) return;
        const r = await sendJson(`/api/projects/${projectId}/models?modelId=${encodeURIComponent(modelId)}`, 'DELETE');
        r.ok ? (toast.success(`Revoked ${modelId} — queued jobs cancelled`), onChange()) : toast.error(r.data?.message || 'Failed');
    }

    return (
        <div className="grid gap-3 lg:grid-cols-2">
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
                                <Button variant="danger" size="xs" onClick={() => revoke(m.id)}>Revoke</Button>
                            ) : m.isDefault ? (
                                <Badge tone="green">always on</Badge>
                            ) : (
                                <div className="flex items-end gap-1.5">
                                    <Field label="Optional expiry">
                                        <Input type="datetime-local" className="w-44" value={expiry[m.id] || ''}
                                            onChange={(e) => setExpiry({ ...expiry, [m.id]: e.target.value })} />
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
    const [form, setForm] = useState({ userId: '', modelId: '', effect: 'deny', validUntil: '' });

    async function add() {
        const r = await sendJson(`/api/projects/${projectId}/overrides`, 'POST', {
            ...form, validUntil: form.validUntil ? new Date(form.validUntil).toISOString() : null,
        });
        r.ok ? (toast.success(`Override saved (${form.effect})`), onChange()) : toast.error(r.data?.message || 'Failed');
    }
    async function remove(o) {
        const r = await sendJson(`/api/projects/${projectId}/overrides?userId=${encodeURIComponent(o.user_id)}&modelId=${encodeURIComponent(o.model_id)}`, 'DELETE');
        r.ok ? (toast.success('Override removed'), onChange()) : toast.error(r.data?.message || 'Failed');
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
        { accessorKey: 'valid_until', header: 'Expires', cell: ({ getValue }) => <span className="font-mono text-ink-3">{getValue() ? fmtDate(getValue()) : 'never'}</span> },
        { id: 'actions', header: '', enableSorting: false, cell: ({ row }) => <Button variant="ghost" size="xs" onClick={() => remove(row.original)}><Trash2 size={13} className="text-danger" /></Button> },
    ];
    return (
        <div>
            <Card className="mb-4">
                <div className="grid items-end gap-2 sm:grid-cols-5">
                    <Field label="User">
                        <Select className="w-full" value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
                            <option value="">Select…</option>
                            {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.email || m.user_id}</option>)}
                        </Select>
                    </Field>
                    <Field label="Model">
                        <Select className="w-full" value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })}>
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
                    <Field label="Expires (optional)">
                        <Input type="datetime-local" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} />
                    </Field>
                    <Button variant="primary" onClick={add} disabled={!form.userId || !form.modelId}>Save override</Button>
                </div>
            </Card>
            <DataTable columns={columns} data={overrides} searchable={false} empty="No user overrides — everyone follows the project grants." />
        </div>
    );
}
