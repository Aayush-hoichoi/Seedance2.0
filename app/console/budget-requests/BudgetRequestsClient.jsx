'use client';

import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { BellRing, Check, X } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select } from '../ui.jsx';
import { fmtDate, fmtUsd, sendJson, useApi } from '../lib.js';

export default function BudgetRequestsClient() {
    const { data, error, mutate } = useApi('/api/admin/budget-requests');
    const [review, setReview] = useState(null);
    const [deny, setDeny] = useState(null);
    const [policy, setPolicy] = useState('hard');
    const [amount, setAmount] = useState('');
    const [reason, setReason] = useState('');
    const [saving, setSaving] = useState(false);
    const requests = data?.requests ?? [];
    const pending = useMemo(() => requests.filter((item) => item.status === 'pending'), [requests]);
    const decided = useMemo(() => requests.filter((item) => item.status !== 'pending'), [requests]);
    // The amount is the admin's to set, so the field is the source of truth from
    // the moment the modal opens — the request only seeds it.
    const approvedAmount = Number(amount);
    const amountValid = Number.isFinite(approvedAmount) && approvedAmount > 0;
    const amountDelta = amountValid && review ? approvedAmount - Number(review.increaseAmount) : 0;

    function openReview(item) {
        setReview(item);
        setPolicy('hard');
        setAmount(String(item.increaseAmount ?? ''));
        setReason('');
    }

    async function decide(item, action) {
        if (action === 'approve' && !amountValid) return toast.error('Enter an approved amount greater than zero.');
        setSaving(true);
        const body = action === 'approve'
            ? { policy, reason, approvedAmount }
            : { reason };
        const response = await sendJson(`/api/admin/budget-requests/${item.id}/${action}`, 'POST', body);
        setSaving(false);
        if (!response.ok) return toast.error(response.data?.error || 'Could not update the request.');
        toast.success(action === 'approve'
            ? `Approved ${fmtUsd(approvedAmount)} — budget raised and model access granted`
            : 'Budget request denied');
        setReview(null);
        setDeny(null);
        setReason('');
        mutate();
    }

    return (
        <div>
            <PageHeader title="Budget requests" subtitle="Review user requests, set warning and enforced limits, then approve or deny" />
            {error ? <EmptyState title="Couldn’t load budget requests" hint={error.message} /> : null}
            {!error && data && !requests.length ? (
                <EmptyState icon={BellRing} title="No budget requests" hint="New requests from project workspaces will appear here and trigger a live notification." />
            ) : null}

            {pending.length ? (
                <section>
                    <div className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-warn">Pending · {pending.length}</div>
                    <div className="grid gap-3 lg:grid-cols-2">
                        {pending.map((item) => (
                            <RequestCard key={item.id} item={item}>
                                <Button variant="primary" onClick={() => openReview(item)}><Check size={13} /> Review &amp; approve</Button>
                                <Button variant="outline" onClick={() => { setDeny(item); setReason(''); }}><X size={13} /> Deny</Button>
                            </RequestCard>
                        ))}
                    </div>
                </section>
            ) : null}

            {decided.length ? (
                <section className={pending.length ? 'mt-8' : ''}>
                    <div className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-ink-3">Request history</div>
                    <div className="grid gap-3 lg:grid-cols-2">
                        {decided.map((item) => <RequestCard key={item.id} item={item} />)}
                    </div>
                </section>
            ) : null}

            <Modal open={!!review} onOpenChange={(open) => { if (!open && !saving) setReview(null); }} title={`Approve ${review?.userName || 'requester'}’s budget?`}
                footer={<>
                    <Button variant="outline" disabled={saving} onClick={() => setReview(null)}>Cancel</Button>
                    <Button variant="primary" loading={saving} disabled={!amountValid} onClick={() => decide(review, 'approve')}>Approve budget</Button>
                </>}>
                <p className="text-xs leading-relaxed text-ink-3">
                    Edit the amount to grant more or less than was asked for, then choose the limit behavior.
                    Approval also grants {review?.modelName} at {review?.quality} quality and every lower quality.
                </p>
                <Field label="Approved increase (USD)">
                    <Input type="number" min="0.01" step="0.01" inputMode="decimal" className="w-full font-mono tabular-nums"
                        value={amount} onChange={(e) => setAmount(e.target.value)} />
                </Field>
                {/* Outside the Field: it renders a <label>, which takes phrasing
                    content only — and a button inside a label steals its click. */}
                <div className="-mt-1 flex items-center justify-between gap-2 text-[11px]">
                    <span className={amountValid ? 'text-ink-3' : 'text-danger'}>
                        {!amountValid ? 'Enter an amount greater than zero.'
                            : amountDelta === 0 ? `Matches the ${fmtUsd(review?.increaseAmount)} requested.`
                                : `${fmtUsd(Math.abs(amountDelta))} ${amountDelta > 0 ? 'more than' : 'less than'} the ${fmtUsd(review?.increaseAmount)} requested.`}
                    </span>
                    {amountDelta !== 0 ? (
                        <button type="button" className="shrink-0 text-accent-hi hover:underline"
                            onClick={() => setAmount(String(review?.increaseAmount ?? ''))}>Reset to requested</button>
                    ) : null}
                </div>
                <Field label="Limit behavior">
                    <Select className="w-full" value={policy} onChange={(e) => setPolicy(e.target.value)}>
                        <option value="hard">Hard limit — block exactly at the cap</option>
                        <option value="soft">Soft limit — warn and allow 5% overage</option>
                    </Select>
                </Field>
                <div className="rounded-md border border-line bg-paper-3 px-3 py-2 text-xs text-ink-2">
                    Approving adds <span className="font-mono font-semibold text-accent-hi">{amountValid ? fmtUsd(approvedAmount) : '—'}</span> to the latest live cap.
                    The cap was <span className="font-mono text-ink">{review?.currentLimit == null ? 'not configured' : fmtUsd(review.currentLimit)}</span> when this request was submitted.
                    Editing the amount changes what is added, never what the user has already spent or holds.
                </div>
                <p className="text-[11px] leading-relaxed text-ink-3">
                    {policy === 'hard'
                        ? 'Hard policy rejects new generations once the hard cap is reached.'
                        : 'Soft policy sends the configured warning and permits up to 5% beyond the hard cap before rejecting.'}
                </p>
                <Reason value={reason} onChange={setReason} label="Decision note (optional)" />
            </Modal>

            <Modal open={!!deny} onOpenChange={(open) => { if (!open && !saving) setDeny(null); }} title="Deny this budget request?"
                footer={<>
                    <Button variant="outline" disabled={saving} onClick={() => setDeny(null)}>Cancel</Button>
                    <Button variant="danger" loading={saving} onClick={() => decide(deny, 'deny')}>Deny request</Button>
                </>}>
                <p className="text-sm text-ink-2">{deny?.userName} will be notified immediately.</p>
                <Reason value={reason} onChange={setReason} label="Reason (optional)" />
            </Modal>
        </div>
    );
}

function RequestCard({ item, children }) {
    const statusTone = item.status === 'approved' ? 'green' : item.status === 'denied' ? 'red' : 'amber';
    return (
        <Card className={item.status === 'pending' ? 'border-warn/25' : ''}>
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="font-display text-base font-semibold text-ink">{item.projectName}</div>
                    <div className="mt-0.5 text-xs text-ink-3">{item.userName}{item.userEmail && item.userEmail !== item.userName ? ` · ${item.userEmail}` : ''}</div>
                </div>
                <Badge tone={statusTone}>{item.status}</Badge>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                <Detail label="Models" value={item.modelName} />
                <Detail label="Quality" value={`${item.quality} and lower`} capitalize />
                <Detail label="Spent this month" value={fmtUsd(item.spent)} mono />
                <Detail label="Requested increase" value={fmtUsd(item.increaseAmount)} mono accent />
                <Detail label="Current limit" value={item.currentLimit == null ? 'No personal limit' : fmtUsd(item.currentLimit)} mono />
                <Detail label="Requested" value={fmtDate(item.createdAt)} />
            </dl>
            <div className="mt-4 rounded-md border border-line bg-paper-3 px-3 py-2 text-xs leading-relaxed text-ink-2">
                <span className="text-ink-3">Reason: </span>{item.reason || 'No reason provided.'}
            </div>
            {item.status === 'approved' ? (
                <div className="mt-3 text-xs text-ok">
                    Approved · {item.decision?.policy || 'hard'} policy · limit {fmtUsd(item.decision?.limit ?? item.decision?.hardLimit)}
                    {item.decision?.amountAdjusted ? (
                        <span className="text-warn"> · granted {fmtUsd(item.decision.approvedIncrease)} of the {fmtUsd(item.decision.requestedIncrease ?? item.increaseAmount)} requested</span>
                    ) : null}
                </div>
            ) : null}
            {item.status === 'denied' && item.decisionReason ? <div className="mt-3 text-xs text-danger">Denied: {item.decisionReason}</div> : null}
            {children ? <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">{children}</div> : null}
        </Card>
    );
}

function Detail({ label, value, mono, accent, capitalize }) {
    return (
        <div>
            <dt className="text-[10px] uppercase tracking-wider text-ink-3">{label}</dt>
            <dd className={`mt-0.5 ${mono ? 'font-mono tabular-nums' : ''} ${accent ? 'font-semibold text-accent-hi' : 'text-ink-2'} ${capitalize ? 'capitalize' : ''}`}>{value}</dd>
        </div>
    );
}

function Reason({ value, onChange, label }) {
    return (
        <Field label={label}>
            <textarea rows={3} maxLength={500} value={value} onChange={(e) => onChange(e.target.value)}
                className="w-full resize-none rounded-md border border-line bg-paper-3 px-2.5 py-2 text-xs text-ink outline-none focus:border-accent/50" />
        </Field>
    );
}
