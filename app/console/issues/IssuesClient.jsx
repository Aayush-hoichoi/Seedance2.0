'use client';

// Generation issues reported from the studio. Same two-section shape as
// BudgetRequestsClient (open first, then history) — an admin reads the error,
// then dismisses the issue once it is handled. Dismiss is the ONLY closing
// action; the 'resolved' status is still rendered because rows closed that way
// before the button was dropped must keep displaying correctly.

import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Bug, X } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Field, Modal, PageHeader } from '../ui.jsx';
import { fmtDate, sendJson, useApi } from '../lib.js';

export default function IssuesClient() {
    const { data, error, mutate } = useApi('/api/admin/issues');
    const [dismiss, setDismiss] = useState(null); // the issue being closed
    const [note, setNote] = useState('');
    const [saving, setSaving] = useState(false);
    const issues = data?.issues ?? [];
    const open = useMemo(() => issues.filter((item) => item.status === 'open'), [issues]);
    const closed = useMemo(() => issues.filter((item) => item.status !== 'open'), [issues]);

    async function submit() {
        setSaving(true);
        const response = await sendJson(`/api/admin/issues/${dismiss.id}/dismiss`, 'POST', { note });
        setSaving(false);
        if (!response.ok) return toast.error(response.data?.error || 'Could not close the issue.');
        toast.success('Issue dismissed');
        setDismiss(null);
        setNote('');
        mutate();
    }

    return (
        <div>
            <PageHeader title="Issues" subtitle="Generation failures reported by users, with the error the provider actually returned" />
            {error ? <EmptyState title="Couldn’t load issues" hint={error.message} /> : null}
            {!error && data && !issues.length ? (
                <EmptyState icon={Bug} title="No issues reported" hint="When a generation fails, users can send the error here from the studio — it arrives with a live notification." />
            ) : null}

            {open.length ? (
                <section>
                    <div className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-warn">Open · {open.length}</div>
                    <div className="grid gap-3 lg:grid-cols-2">
                        {open.map((item) => (
                            <IssueCard key={item.id} item={item}>
                                <Button variant="outline" onClick={() => { setDismiss(item); setNote(''); }}><X size={13} /> Dismiss</Button>
                            </IssueCard>
                        ))}
                    </div>
                </section>
            ) : null}

            {closed.length ? (
                <section className={open.length ? 'mt-8' : ''}>
                    <div className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-ink-3">Closed</div>
                    <div className="grid gap-3 lg:grid-cols-2">
                        {closed.map((item) => <IssueCard key={item.id} item={item} />)}
                    </div>
                </section>
            ) : null}

            <Modal open={!!dismiss} onOpenChange={(o) => { if (!o && !saving) setDismiss(null); }}
                title="Dismiss this issue?"
                footer={<>
                    <Button variant="outline" disabled={saving} onClick={() => setDismiss(null)}>Cancel</Button>
                    <Button variant="danger" loading={saving} onClick={submit}>Dismiss</Button>
                </>}>
                <p className="text-sm text-ink-2">
                    {dismiss?.userName}’s report on {dismiss?.modelName} will move to the closed list.
                </p>
                <Field label="Note (optional)">
                    <textarea rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
                        className="w-full resize-none rounded-md border border-line bg-paper-3 px-2.5 py-2 text-xs text-ink outline-none focus:border-accent/50" />
                </Field>
            </Modal>
        </div>
    );
}

function attemptsText(attempts = {}) {
    const parts = [`${attempts.userRetries ?? 1} ${attempts.userRetries === 1 ? 'try' : 'tries'}`];
    if (attempts.submitAttempts > 1) parts.push(`${attempts.submitAttempts} submit retries`);
    if (attempts.serverAttempt > 1) parts.push(`gateway attempt ${attempts.serverAttempt}`);
    return parts.join(' · ');
}

function IssueCard({ item, children }) {
    const tone = item.status === 'resolved' ? 'green' : item.status === 'dismissed' ? 'zinc' : 'amber';
    const providerError = item.server?.error;
    return (
        <Card className={item.status === 'open' ? 'border-warn/25' : ''}>
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="font-display text-base font-semibold text-ink">{item.projectName}</div>
                    <div className="mt-0.5 text-xs text-ink-3">{item.userName}{item.userEmail && item.userEmail !== item.userName ? ` · ${item.userEmail}` : ''}</div>
                </div>
                <Badge tone={tone}>{item.status}</Badge>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                <Detail label="Model" value={item.modelName || item.modelId} />
                <Detail label="Attempts" value={attemptsText(item.attempts)} accent />
                <Detail label="Mode" value={item.modeId || '—'} />
                <Detail label="Reported" value={fmtDate(item.createdAt)} />
                {item.jobRef?.taskId ? <Detail label="Task" value={item.jobRef.taskId} mono span /> : null}
                {item.server ? <Detail label="Gateway job" value={`#${item.server.jobId} · ${item.server.status}${item.server.providerId ? ` · ${item.server.providerId}` : ''}`} mono span /> : null}
            </dl>
            {item.note ? (
                <div className="mt-4 rounded-md border border-line bg-paper-3 px-3 py-2 text-xs leading-relaxed text-ink-2">
                    <span className="text-ink-3">They said: </span>{item.note}
                </div>
            ) : null}
            <LogBlock label="Error shown to the user" value={item.clientError} />
            {/* The provider's own object is what a fix actually starts from —
                the browser never sees it, the gateway job row does. */}
            <LogBlock label="Provider error" value={providerError} />
            {!item.server ? (
                <p className="mt-2 text-[11px] text-ink-3">No gateway job matched — the request likely failed before reaching a provider.</p>
            ) : null}
            {item.prompt ? (
                <details className="mt-3 text-xs">
                    <summary className="cursor-pointer text-ink-3 hover:text-ink-2">Prompt</summary>
                    <p className="mt-1.5 leading-relaxed text-ink-2">{item.prompt}</p>
                </details>
            ) : null}
            {item.status !== 'open' ? (
                <div className="mt-3 text-xs text-ink-3">
                    {item.status === 'resolved' ? 'Resolved' : 'Dismissed'} by {item.decidedBy || 'an admin'} · {fmtDate(item.decidedAt)}
                    {item.decisionNote ? ` — “${item.decisionNote}”` : ''}
                </div>
            ) : null}
            {children ? <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">{children}</div> : null}
        </Card>
    );
}

function LogBlock({ label, value }) {
    if (!value) return null;
    const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return (
        <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wider text-ink-3">{label}</div>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-paper-3 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-2">{body}</pre>
        </div>
    );
}

function Detail({ label, value, mono, accent, span }) {
    return (
        <div className={span ? 'col-span-2 min-w-0' : 'min-w-0'}>
            <dt className="text-[10px] uppercase tracking-wider text-ink-3">{label}</dt>
            <dd className={`mt-0.5 truncate ${mono ? 'font-mono' : ''} ${accent ? 'font-semibold text-accent-hi' : 'text-ink-2'}`} title={String(value ?? '')}>{value}</dd>
        </div>
    );
}
