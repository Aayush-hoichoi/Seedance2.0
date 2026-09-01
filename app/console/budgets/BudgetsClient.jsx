'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { PageHeader, Card, Badge, Button, Modal, Field, Input, Select, ProgressBar, EmptyState } from '../ui.jsx';
import { useApi, sendJson, fmtUsd, fmtInt } from '../lib.js';
import { Wallet, Plus, Trash2 } from 'lucide-react';

const TYPES = [
    ['usd', 'Dollars (USD)'], ['image_count', 'Image count'],
    ['video_seconds', 'Video seconds'], ['request_count', 'Requests'],
];

export default function BudgetsClient() {
    const quotas = useApi('/api/admin/quotas?withUsage=1');
    const models = useApi('/api/admin/models');
    const projects = useApi('/api/projects');
    const users = useApi('/api/admin/users');
    const [open, setOpen] = useState(false);
    const [toRemove, setToRemove] = useState(null);
    const [removing, setRemoving] = useState(false);
    const [form, setForm] = useState({ type: 'usd', window: 'lifetime', hardLimit: '', policy: 'hard', softOveragePct: 5, projectId: '', userId: '', modelId: '' });

    async function create() {
        const r = await sendJson('/api/admin/quotas', 'POST', {
            ...form,
            hardLimit: Number(form.hardLimit),
            projectId: form.projectId ? Number(form.projectId) : null,
            userId: form.userId || null,
            modelId: form.modelId || null,
        });
        r.ok
            ? (toast.success(r.data?.created === false ? 'Existing budget topped up' : 'Budget created — enforced on the next request'), setOpen(false), quotas.mutate())
            : toast.error(r.data?.message || 'Failed');
    }
    async function remove() {
        if (!toRemove) return;
        setRemoving(true);
        const r = await sendJson(`/api/admin/quotas?id=${toRemove.id}`, 'DELETE');
        setRemoving(false);
        if (!r.ok) return toast.error(r.data?.message || 'Failed');
        toast.success('Budget removed');
        setToRemove(null);
        quotas.mutate();
    }

    const items = quotas.data?.items ?? [];
    // Dedicated catalog request avoids coupling this picker to the slower
    // per-quota usage aggregation. Keep the inline payload as a compatibility
    // fallback while older/newer deployments overlap during rollout.
    const modelItems = models.data?.items ?? quotas.data?.models ?? [];
    const fmt = (q, v) => (q.type === 'usd' ? fmtUsd(v) : fmtInt(v));
    // Quotas store the Clerk user id; show the email humans recognize.
    const emailOf = (id) => (users.data?.users ?? []).find((u) => u.id === id)?.email || `${id.slice(0, 14)}…`;

    // Live, plain-language summary of what the budget being created will do.
    const UNIT = { usd: '$', image_count: ' images', video_seconds: ' video-sec', request_count: ' requests' };
    const limitText = form.hardLimit ? (form.type === 'usd' ? `$${form.hardLimit}` : `${form.hardLimit}${UNIT[form.type]}`) : '—';
    const scopeProject = (projects.data?.items ?? []).find((p) => String(p.id) === String(form.projectId))?.name;
    const scopeUser = (users.data?.users ?? []).find((u) => u.id === form.userId)?.email;
    const scopeModel = modelItems.find((m) => m.id === form.modelId)?.display_name;
    const scopeText = `${scopeProject ? `project “${scopeProject}”` : 'all projects'} · ${scopeUser || 'everyone'} · ${scopeModel || 'all models'}`;

    return (
        <div>
            <PageHeader title="Budgets & quotas" subtitle="Checked before any job reaches a provider — reservations make bursts race-safe">
                <Button variant="primary" onClick={() => setOpen(true)}><Plus size={14} /> New budget</Button>
            </PageHeader>
            {quotas.error?.code === 'FORBIDDEN'
                ? <EmptyState title="Requires quota.manage" hint="Budgets are managed by admins and project managers." />
                : !items.length
                    ? <EmptyState icon={Wallet} title="No budgets yet" hint="Without budgets every allowed request goes through. Add a workspace-wide, per-project, per-user, or per-model limit — hard limits reject, soft limits allow a small overage." />
                    : (
                        <div className="grid gap-3 lg:grid-cols-2">
                            {items.map((q) => {
                                const projected = Number(q.used) + Number(q.reserved || 0);
                                return (
                                    <Card key={q.id}>
                                        <div className="mb-1 flex items-center justify-between">
                                            <div className="text-sm font-medium text-ink">
                                                {[
                                                    q.project_name ? `Project · ${q.project_name}` : null,
                                                    q.user_id ? `User · ${emailOf(q.user_id)}` : null,
                                                    q.model_id ? `Model · ${q.model_name || q.model_id}` : null,
                                                ].filter(Boolean).join(' · ') || 'Workspace-wide'}
                                            </div>
                                            <div className="flex items-center gap-1.5">
                                                <Badge tone={q.policy === 'hard' ? 'red' : 'amber'}>{q.policy}{q.policy === 'soft' ? ` +${q.soft_overage_pct}%` : ''}</Badge>
                                                <Button variant="ghost" size="xs" title="Delete budget" onClick={() => setToRemove(q)}><Trash2 size={13} className="text-danger" /></Button>
                                            </div>
                                        </div>
                                        <div className="mb-2 text-xs text-ink-3">
                                            {q.type} · {q.window} · alerts at {(q.alert_thresholds || []).join('/')}% ·
                                            {' '}{fmt(q, q.used)} used{Number(q.reserved) > 0 ? ` + ${fmt(q, q.reserved)} in flight` : ''} of {fmt(q, q.hard_limit)}
                                        </div>
                                        <ProgressBar value={projected} max={Number(q.hard_limit)} />
                                    </Card>
                                );
                            })}
                        </div>
                    )}
            <Modal open={open} onOpenChange={setOpen} title="New budget"
                footer={<>
                    <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                    <Button variant="primary" onClick={create} disabled={!(Number(form.hardLimit) > 0)}>Create</Button>
                </>}>
                <p className="mb-3 text-xs leading-relaxed text-ink-3">
                    A budget caps spend or usage <span className="text-ink-2">before a job runs</span>. Scope it to a
                    project, user, and/or model, or leave all three blank for a workspace-wide cap. <span className="text-ink-2">Hard</span> budgets
                    reject once the limit is hit; <span className="text-ink-2">soft</span> budgets allow a small overage and only warn.
                </p>
                <div className="grid grid-cols-2 gap-3">
                    <Field label="Type">
                        <Select className="w-full" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                            {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </Select>
                    </Field>
                    <Field label="Window">
                        <Select className="w-full" value={form.window} disabled={!!form.projectId}
                            onChange={(e) => setForm({ ...form, window: e.target.value })}>
                            {form.projectId
                                ? <option value="lifetime">lifetime</option>
                                : <><option value="daily">daily</option><option value="monthly">monthly</option><option value="lifetime">lifetime</option></>}
                        </Select>
                    </Field>
                    <Field label="Limit">
                        <Input type="number" min="0" step="any" value={form.hardLimit} onChange={(e) => setForm({ ...form, hardLimit: e.target.value })} placeholder={form.type === 'usd' ? '100' : '50'} />
                    </Field>
                    <Field label="Policy">
                        <Select className="w-full" value={form.policy} onChange={(e) => setForm({ ...form, policy: e.target.value })}>
                            <option value="hard">hard — reject at limit</option>
                            <option value="soft">soft — allow small overage</option>
                        </Select>
                    </Field>
                    <Field label="Project (blank = all projects)">
                        <Select className="w-full" value={form.projectId}
                            onChange={(e) => setForm({ ...form, projectId: e.target.value, window: e.target.value ? 'lifetime' : form.window })}>
                            <option value="">—</option>
                            {(projects.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </Select>
                    </Field>
                    <Field label="User (blank = everyone)">
                        <Select className="w-full" value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
                            <option value="">—</option>
                            {(users.data?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.email || u.name || u.id}</option>)}
                        </Select>
                    </Field>
                    <Field label="Model (blank = all models)">
                        <Select className="w-full" value={form.modelId} disabled={!modelItems.length}
                            onChange={(e) => setForm({ ...form, modelId: e.target.value })}>
                            <option value="">
                                {models.error ? 'Could not load models' : models.isLoading ? 'Loading models…' : '—'}
                            </option>
                            {modelItems.map((m) => <option key={m.id} value={m.id}>{m.display_name} · {m.category}</option>)}
                        </Select>
                    </Field>
                </div>
                {form.policy === 'soft' ? (
                    <Field label="Overage % — how far past the limit a soft budget may go">
                        <Input type="number" min="1" max="50" value={form.softOveragePct} onChange={(e) => setForm({ ...form, softOveragePct: Number(e.target.value) })} />
                    </Field>
                ) : null}
                <div className="mt-3 rounded-md border border-line bg-paper-2 px-3 py-2 text-xs leading-relaxed text-ink-2">
                    Caps <span className="font-medium text-ink">{limitText} {form.window}</span> for{' '}
                    <span className="font-medium text-ink">{scopeText}</span>.{' '}
                    {form.policy === 'hard'
                        ? 'Requests past the limit are rejected.'
                        : `Allows a ~${form.softOveragePct}% overage, then just warns.`}
                </div>
            </Modal>
            <Modal open={!!toRemove} onOpenChange={(nextOpen) => { if (!nextOpen && !removing) setToRemove(null); }}
                title="Delete this budget?"
                footer={<>
                    <Button variant="outline" onClick={() => setToRemove(null)} disabled={removing}>Cancel</Button>
                    <Button variant="danger" onClick={remove} loading={removing}>Delete budget</Button>
                </>}>
                <p className="text-sm text-ink-2">
                    This removes the spending cap immediately, but does not spend or waste its remaining allowance.
                    Existing usage history is retained. The affected scope falls back to any broader applicable budget; if none exists, this specific cap no longer restricts it.
                </p>
            </Modal>
        </div>
    );
}
