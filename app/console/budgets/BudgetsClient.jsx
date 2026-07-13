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
    const projects = useApi('/api/projects');
    const users = useApi('/api/admin/users');
    const [open, setOpen] = useState(false);
    const [form, setForm] = useState({ type: 'usd', window: 'monthly', hardLimit: '', policy: 'hard', softOveragePct: 5, projectId: '', userId: '' });

    async function create() {
        const r = await sendJson('/api/admin/quotas', 'POST', {
            ...form,
            hardLimit: Number(form.hardLimit),
            projectId: form.projectId ? Number(form.projectId) : null,
            userId: form.userId || null,
        });
        r.ok ? (toast.success('Budget created — enforced on the next request'), setOpen(false), quotas.mutate()) : toast.error(r.data?.message || 'Failed');
    }
    async function remove(id) {
        const r = await sendJson(`/api/admin/quotas?id=${id}`, 'DELETE');
        r.ok ? (toast.success('Budget removed'), quotas.mutate()) : toast.error(r.data?.message || 'Failed');
    }

    const items = quotas.data?.items ?? [];
    const fmt = (q, v) => (q.type === 'usd' ? fmtUsd(v) : fmtInt(v));
    // Quotas store the Clerk user id; show the email humans recognize.
    const emailOf = (id) => (users.data?.users ?? []).find((u) => u.id === id)?.email || `${id.slice(0, 14)}…`;

    return (
        <div>
            <PageHeader title="Budgets & quotas" subtitle="Checked before any job reaches a provider — reservations make bursts race-safe">
                <Button variant="primary" onClick={() => setOpen(true)}><Plus size={14} /> New budget</Button>
            </PageHeader>
            {quotas.error?.code === 'FORBIDDEN'
                ? <EmptyState title="Requires quota.manage" hint="Budgets are managed by admins and project managers." />
                : !items.length
                    ? <EmptyState icon={Wallet} title="No budgets yet" hint="Without budgets every allowed request goes through. Add an org, project, or per-user limit — hard limits reject, soft limits allow a small overage." />
                    : (
                        <div className="grid gap-3 lg:grid-cols-2">
                            {items.map((q) => {
                                const projected = Number(q.used) + Number(q.reserved || 0);
                                return (
                                    <Card key={q.id}>
                                        <div className="mb-1 flex items-center justify-between">
                                            <div className="text-sm font-medium text-ink">
                                                {q.user_id ? `User · ${emailOf(q.user_id)}` : q.project_name ? `Project · ${q.project_name}` : 'Whole organization'}
                                            </div>
                                            <div className="flex items-center gap-1.5">
                                                <Badge tone={q.policy === 'hard' ? 'red' : 'amber'}>{q.policy}{q.policy === 'soft' ? ` +${q.soft_overage_pct}%` : ''}</Badge>
                                                <Button variant="ghost" size="xs" onClick={() => remove(q.id)}><Trash2 size={13} className="text-danger" /></Button>
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
                <div className="grid grid-cols-2 gap-3">
                    <Field label="Type">
                        <Select className="w-full" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                            {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </Select>
                    </Field>
                    <Field label="Window">
                        <Select className="w-full" value={form.window} onChange={(e) => setForm({ ...form, window: e.target.value })}>
                            <option value="daily">daily</option><option value="monthly">monthly</option><option value="lifetime">lifetime</option>
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
                    <Field label="Project (blank = whole org)">
                        <Select className="w-full" value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
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
                </div>
                {form.policy === 'soft' ? (
                    <Field label="Overage %">
                        <Input type="number" min="1" max="50" value={form.softOveragePct} onChange={(e) => setForm({ ...form, softOveragePct: Number(e.target.value) })} />
                    </Field>
                ) : null}
            </Modal>
        </div>
    );
}
