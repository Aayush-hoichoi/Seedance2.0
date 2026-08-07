'use client';

import { useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import dynamic from 'next/dynamic';
import toast from 'react-hot-toast';
import { PageHeader, Card, Badge, Button, Modal, Field, Input, Select, DataTable, ProgressBar, EmptyState, DateTimePicker } from '../../ui.jsx';
import { useApi, sendJson, fmtUsd, fmtInt, fmtDate, monthStartIso } from '../../lib.js';
import { supportedResolutionsFor } from '../../../../lib/seedance/constants.js';
import { PauseCircle, Pencil, PlayCircle, Plus, ShieldBan, ShieldCheck, Trash2, Wallet } from 'lucide-react';

const SpendDonut = dynamic(() => import('../../charts.jsx').then((m) => m.SpendDonut), { ssr: false });
const TopBars = dynamic(() => import('../../charts.jsx').then((m) => m.TopBars), { ssr: false });

const TAB = 'rounded-lg px-3 py-1.5 text-sm text-ink-2 data-[state=active]:bg-paper-3 data-[state=active]:text-ink';
const BUDGET_TYPES = [
    ['usd', 'Dollars (USD)'], ['image_count', 'Image count'],
    ['video_seconds', 'Video seconds'], ['request_count', 'Requests'],
];

export default function ProjectDetailClient({ projectId }) {
    const [editingBudget, setEditingBudget] = useState(null);
    const detail = useApi(`/api/projects/${projectId}`);
    const models = useApi(`/api/models?projectId=${projectId}`);
    const usersApi = useApi('/api/admin/users');
    const usageByModel = useApi(`/api/projects/${projectId}/usage?group_by=model&from=${monthStartIso()}`);
    const viewerRole = detail.data?.role;
    const isAdmin = viewerRole === 'admin' || viewerRole === 'owner';
    const budgetModels = useApi(isAdmin ? '/api/admin/models' : null);
    const usage = useApi(`/api/projects/${projectId}/usage?group_by=user${isAdmin ? '&include_model_breakdown=1' : ''}&from=${monthStartIso()}`);
    const quotas = useApi(isAdmin
        ? `/api/admin/quotas?withUsage=1&withModelBreakdown=1&projectId=${projectId}`
        : null);

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
                <Tabs.List className="mb-4 flex gap-1 border-b border-line pb-2">
                    <Tabs.Trigger value="members" className={TAB}>Members</Tabs.Trigger>
                    {isAdmin && <Tabs.Trigger value="models" className={TAB}>Models</Tabs.Trigger>}
                    {isAdmin && <Tabs.Trigger value="overrides" className={TAB}>Overrides</Tabs.Trigger>}
                    <Tabs.Trigger value="budget" className={TAB}>Budget</Tabs.Trigger>
                    <Tabs.Trigger value="usage" className={TAB}>Usage</Tabs.Trigger>
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
                    <div className="grid gap-3 lg:grid-cols-2">
                        {projectQuotas.map((q) => (
                            <Card key={q.id}>
                                <div className="mb-3 flex items-start justify-between gap-3">
                                    <div>
                                        <div className="text-sm font-medium text-ink">{q.project_name || project.name}</div>
                                        <div className="mt-0.5 text-xs text-ink-3">{q.type} · {q.window}{q.model_name ? ` · ${q.model_name}` : ''}</div>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <Badge tone={q.policy === 'hard' ? 'red' : 'amber'}>{q.policy}{q.policy === 'soft' ? ` +${q.soft_overage_pct}%` : ''}</Badge>
                                        {isAdmin ? (
                                            <Button variant="ghost" size="xs" title="Edit budget cap" aria-label="Edit budget cap"
                                                onClick={() => setEditingBudget(q)}>
                                                <Pencil size={13} />
                                            </Button>
                                        ) : null}
                                    </div>
                                </div>
                                <div className="mb-3 grid grid-cols-3 gap-3 rounded-md border border-line bg-paper-3 px-3 py-2.5">
                                    <BudgetCardValue label="Project" value={q.project_name || project.name} />
                                    <BudgetCardValue label="User" value={q.user_id ? emailOf(q.user_id) : 'Everyone'} />
                                    <BudgetCardValue
                                        label="Spent"
                                        value={q.type === 'usd' ? fmtUsd(q.used) : fmtInt(q.used)}
                                        hint={Number(q.reserved) > 0 ? `+${q.type === 'usd' ? fmtUsd(q.reserved) : fmtInt(q.reserved)} in flight` : null}
                                    />
                                </div>
                                <div className="mb-2 flex items-center justify-between gap-3 text-xs text-ink-3">
                                    <span>Budget usage</span>
                                    <span className="font-mono tabular-nums text-ink-2">
                                        {q.type === 'usd' ? fmtUsd(Number(q.used) + Number(q.reserved || 0)) : fmtInt(Number(q.used) + Number(q.reserved || 0))}
                                        {' '}of {q.type === 'usd' ? fmtUsd(q.hard_limit) : fmtInt(q.hard_limit)}
                                    </span>
                                </div>
                                <BudgetProgressBar quota={q} />
                            </Card>
                        ))}
                        {isAdmin ? (
                            <AddBudgetCard
                                project={project}
                                members={members}
                                models={budgetModels.data?.items ?? []}
                                modelsLoading={budgetModels.isLoading}
                                modelsError={budgetModels.error}
                                onCreated={() => quotas.mutate()}
                            />
                        ) : !projectQuotas.length ? (
                            <EmptyState title="No budgets on this project" hint="An admin can add a project, per-user, or per-model budget here." />
                        ) : null}
                    </div>
                    {editingBudget ? (
                        <EditBudgetModal
                            key={editingBudget.id}
                            quota={editingBudget}
                            projectName={editingBudget.project_name || project.name}
                            userName={editingBudget.user_id ? emailOf(editingBudget.user_id) : 'Everyone'}
                            onClose={() => setEditingBudget(null)}
                            onUpdated={() => {
                                setEditingBudget(null);
                                quotas.mutate();
                            }}
                        />
                    ) : null}
                </Tabs.Content>
                <Tabs.Content value="usage">
                    <div className="grid gap-4 lg:grid-cols-2">
                        <Card>
                            <div className="mb-2 text-sm font-medium text-ink-2">
                                Per-user spend (this month)
                                {isAdmin ? <span className="ml-1 text-xs font-normal text-ink-3">· Hover a bar for model breakdown</span> : null}
                            </div>
                            {(usage.data?.items ?? []).length
                                ? <TopBars data={usage.data.items} detailed={isAdmin} />
                                : <div className="grid h-[200px] place-items-center text-xs text-ink-3">No usage yet</div>}
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

function BudgetCardValue({ label, value, hint }) {
    return (
        <div className="min-w-0">
            <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-ink-3">{label}</div>
            <div className="mt-1 truncate text-xs font-medium text-ink" title={value}>{value}</div>
            {hint ? <div className="mt-0.5 truncate text-[10px] text-ink-3" title={hint}>{hint}</div> : null}
        </div>
    );
}

function EditBudgetModal({ quota, projectName, userName, onClose, onUpdated }) {
    const format = quota.type === 'usd' ? fmtUsd : fmtInt;
    const wholeNumber = quota.type === 'image_count' || quota.type === 'request_count';
    const [snapshot, setSnapshot] = useState({
        hardLimit: Number(quota.hard_limit),
        used: Number(quota.used || 0),
        reserved: Number(quota.reserved || 0),
    });
    const [newCapInput, setNewCapInput] = useState(String(quota.hard_limit));
    const [reason, setReason] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const newCap = Number(newCapInput);
    const minimumCap = snapshot.used + snapshot.reserved;
    const delta = newCap - snapshot.hardLimit;
    const reducing = Number.isFinite(newCap) && delta < 0;
    const validNumber = Number.isFinite(newCap) && newCap > 0 && (!wholeNumber || Number.isInteger(newCap));
    const valid = validNumber
        && newCap >= minimumCap
        && newCap !== snapshot.hardLimit
        && (!reducing || reason.trim().length >= 3);

    async function save() {
        if (!valid) return;
        setSaving(true);
        setError('');
        const response = await sendJson('/api/admin/quotas', 'PATCH', {
            id: quota.id,
            newHardLimit: newCap,
            expectedHardLimit: snapshot.hardLimit,
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

        toast.success(reducing ? 'Budget cap reduced' : 'Budget cap updated');
        onUpdated();
    }

    const validationMessage = !newCapInput
        ? 'Enter a new cap.'
        : !validNumber
            ? wholeNumber ? 'This budget requires a positive whole number.' : 'Enter a positive number.'
            : newCap < minimumCap
                ? `The cap cannot be below ${format(minimumCap)} (spent plus in-flight usage).`
                : newCap === snapshot.hardLimit
                    ? 'Enter an amount different from the current cap.'
                    : reducing && reason.trim().length < 3
                        ? 'Add a short reason for reducing this budget.'
                        : '';

    return (
        <Modal open onOpenChange={(nextOpen) => { if (!nextOpen && !saving) onClose(); }} title="Edit budget cap"
            footer={<>
                <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
                <Button variant={reducing ? 'danger' : 'primary'} onClick={save} loading={saving} disabled={!valid}>
                    {reducing ? 'Reduce budget' : 'Save cap'}
                </Button>
            </>}>
            <Card className="bg-paper-3">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <BudgetCardValue label="Project" value={projectName} />
                    <BudgetCardValue label="User" value={userName} />
                    <BudgetCardValue label="Spent" value={format(snapshot.used)} />
                    <BudgetCardValue label="In flight" value={format(snapshot.reserved)} />
                    <BudgetCardValue label="Current cap" value={format(snapshot.hardLimit)} />
                    <BudgetCardValue label="Minimum safe cap" value={format(minimumCap)} />
                </div>
            </Card>

            <Field label="New total budget cap">
                <Input type="number" min={minimumCap} step={wholeNumber ? '1' : 'any'} value={newCapInput}
                    onChange={(event) => { setNewCapInput(event.target.value); setError(''); }} />
            </Field>

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
                        onChange={(event) => { setReason(event.target.value); setError(''); }} />
                </Field>
            ) : null}

            {error ? <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div> : null}
            {!error && validationMessage ? <div className="text-xs text-ink-3">{validationMessage}</div> : null}
        </Modal>
    );
}

function AddBudgetCard({ project, members, models, modelsLoading, modelsError, onCreated }) {
    const initialForm = { type: 'usd', window: 'monthly', addAmount: '', policy: 'hard', softOveragePct: 5, userId: '', modelId: '' };
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [form, setForm] = useState(initialForm);
    const previewParams = new URLSearchParams({
        projectId: String(project.id),
        type: form.type,
        window: form.window,
        ...(form.userId ? { userId: form.userId } : {}),
        ...(form.modelId ? { modelId: form.modelId } : {}),
    });
    const preview = useApi(open ? `/api/admin/quotas/preview?${previewParams}` : null);
    const previewData = preview.data;
    const previewFormat = form.type === 'usd' ? fmtUsd : fmtInt;
    const existingBudget = previewData?.existingBudget;
    const previousCap = Number(previewData?.previouslyAllotted || 0);
    const addAmount = Number(form.addAmount) || 0;
    const newCap = previousCap + addAmount;
    const effectivePolicy = existingBudget?.policy || form.policy;
    const wholeNumber = form.type === 'image_count' || form.type === 'request_count';
    const validAddAmount = addAmount > 0 && (!wholeNumber || Number.isInteger(addAmount));

    function changeOpen(nextOpen) {
        setOpen(nextOpen);
        if (!nextOpen && !saving) setForm(initialForm);
    }

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
        setOpen(false);
        setForm(initialForm);
        onCreated();
    }

    return (
        <>
            <Card className="flex min-h-32 flex-col items-center justify-center border-dashed text-center">
                <span className="mb-3 grid size-9 place-items-center rounded-full border border-line bg-paper-3 text-ink-2">
                    <Wallet size={17} />
                </span>
                <div className="text-sm font-medium text-ink">Add a budget</div>
                <div className="mt-1 max-w-xs text-xs text-ink-3">Cap spend or usage for this project, a member, or a model.</div>
                <Button variant="primary" className="mt-3" onClick={() => setOpen(true)}>
                    <Plus size={14} /> Add budget
                </Button>
            </Card>

            <Modal open={open} onOpenChange={changeOpen} title={`Add budget · ${project.name}`}
                footer={<>
                    <Button variant="outline" onClick={() => changeOpen(false)} disabled={saving}>Cancel</Button>
                    <Button variant="primary" onClick={create} loading={saving}
                        disabled={!validAddAmount || preview.isLoading || !!preview.error}>
                        {existingBudget ? 'Add to budget' : 'Create budget'}
                    </Button>
                </>}>
                <p className="mb-3 text-xs leading-relaxed text-ink-3">
                    This budget applies to <span className="font-medium text-ink-2">{project.name}</span>. Leave member and model blank to cap the whole project. If this scope already has a budget, the amount entered below is added on top of its current cap.
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
                        <Select className="w-full" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                            {BUDGET_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </Select>
                    </Field>
                    <Field label="Window">
                        <Select className="w-full" value={form.window} onChange={(e) => setForm({ ...form, window: e.target.value })}>
                            <option value="daily">daily</option>
                            <option value="monthly">monthly</option>
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
                        <Select className="w-full" value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
                            <option value="">—</option>
                            {members.map((member) => <option key={member.user_id} value={member.user_id}>{member.email || member.name || member.user_id}</option>)}
                        </Select>
                    </Field>
                    <Field label="Model (blank = all models)">
                        <Select className="w-full" value={form.modelId} disabled={!models.length}
                            onChange={(e) => setForm({ ...form, modelId: e.target.value })}>
                            <option value="">{modelsError ? 'Could not load models' : modelsLoading ? 'Loading models…' : '—'}</option>
                            {models.map((model) => <option key={model.id} value={model.id}>{model.display_name} · {model.category}</option>)}
                        </Select>
                    </Field>
                </div>
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
        </>
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
    const [toRemove, setToRemove] = useState(null);
    const [removing, setRemoving] = useState(false);

    // Roles are platform-level (set on the Users console), NOT per-project. The
    // Role column shows each member's platform role, read-only. Adding a member
    // just records that they belong to this project; it never sets a role.
    async function add() {
        const r = await sendJson(`/api/projects/${projectId}/members`, 'POST', { userId });
        if (!r.ok) return toast.error(r.data?.message || 'Failed');
        toast.success('Member added');
        setOpen(false); setUserId(''); onChange();
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
