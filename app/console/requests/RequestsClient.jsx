'use client';

// Every kind of request an admin decides, in one place, one tab per kind:
//   Model access — model_access_requests (incl. tool access like Upscale/EXR
//     tools via the tools flow), reusing the Users page's approve control.
//   Budgets — model AND tool budget increases (EXR, Upscale included),
//     embedding the existing Budget requests experience.
//   Projects — project-initiation asks (approve creates the project).
//   EXR access — the byteplus-exr workspace unlocks from the Enhance Queue.
// The scattered originals (Users, Budget requests, Projects, Enhance Queue)
// keep working; this hub just reads/writes the same endpoints.

import { useState } from 'react';
import toast from 'react-hot-toast';
import { Badge, Button, Card, EmptyState, PageHeader } from '../ui.jsx';
import { useApi, sendJson, timeAgo } from '../lib.js';
import BudgetRequestsClient from '../budget-requests/BudgetRequestsClient.jsx';
import { PendingRequest } from '../users/UsersClient.jsx';
import { Inbox } from 'lucide-react';

export default function RequestsClient() {
    const [tab, setTab] = useState('access');

    // The tab badges share SWR keys with the tab bodies (and with the pages
    // this hub mirrors), so these cost no extra requests.
    const access = useApi('/api/admin/requests', { refreshInterval: 30_000, revalidateOnFocus: true });
    const budgets = useApi('/api/admin/budget-requests', { refreshInterval: 30_000, revalidateOnFocus: true });
    const projects = useApi('/api/admin/project-requests', { refreshInterval: 30_000, revalidateOnFocus: true });
    const exr = useApi('/api/admin/exr-queue', { refreshInterval: 30_000, revalidateOnFocus: true });
    const workflows = useApi('/api/admin/workflow-requests', { refreshInterval: 30_000, revalidateOnFocus: true });

    const accessPending = (access.data?.requests ?? []).filter((r) => r.status === 'pending' || (r.status === 'approved' && r.pending_max_resolution));
    const budgetPending = (budgets.data?.requests ?? []).filter((r) => r.status === 'pending').length;
    const projectPending = (projects.data?.requests ?? []).length;
    const exrPending = (exr.data?.accessRequests ?? []).filter((r) => r.status === 'pending');
    const workflowPending = workflows.data?.requests ?? [];

    const TABS = [
        { id: 'access', label: 'Model access', count: accessPending.length },
        { id: 'budgets', label: 'Budgets', count: budgetPending },
        { id: 'projects', label: 'Projects', count: projectPending },
        { id: 'exr', label: 'EXR access', count: exrPending.length },
        { id: 'workflows', label: 'Workflows', count: workflowPending.length },
    ];

    return (
        <div>
            <PageHeader title="Requests" subtitle="Everything waiting on an admin decision — access, budgets, projects and EXR" />

            <div className="mb-5 flex flex-wrap gap-1 rounded-lg border border-line bg-paper-1 p-1 w-fit" role="tablist">
                {TABS.map((t) => (
                    <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                        className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors ${tab === t.id ? 'bg-paper-3 font-medium text-ink' : 'text-ink-3 hover:text-ink-2'}`}>
                        {t.label}
                        {t.count > 0 && <span className="grid min-w-5 place-items-center rounded-full bg-warn/15 px-1 text-[10px] font-semibold text-warn">{t.count > 99 ? '99+' : t.count}</span>}
                    </button>
                ))}
            </div>

            {tab === 'access' && <ModelAccessTab pending={accessPending} mutate={access.mutate} />}
            {tab === 'budgets' && <BudgetRequestsClient embedded />}
            {tab === 'projects' && <ProjectsTab requests={projects.data?.requests ?? []} mutate={projects.mutate} />}
            {tab === 'exr' && <ExrAccessTab requests={exrPending} mutate={exr.mutate} />}
            {tab === 'workflows' && <WorkflowAccessTab requests={workflowPending} mutate={workflows.mutate} />}
        </div>
    );
}

// Workflow access — one request per user; approving unlocks EVERY workflow
// for the requester in the studio's Workflows picker.
function WorkflowAccessTab({ requests, mutate }) {
    async function decide(userId, action) {
        const r = await sendJson('/api/admin/workflow-requests', 'PATCH', { userId, action });
        if (!r.ok) return toast.error(r.data?.error || 'Could not decide the workflow request.');
        toast.success(action === 'approve' ? 'Workflow access approved.' : 'Workflow access denied.');
        mutate();
    }
    if (!requests.length) {
        return <EmptyState icon={Inbox} title="No pending workflow requests" hint="Users request access from the studio's Workflows picker; one approval unlocks every workflow for them." />;
    }
    return (
        <Card>
            <ul className="divide-y divide-line/60">
                {requests.map((r) => (
                    <li key={r.user_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                        <div className="min-w-0 text-sm">
                            <div className="font-medium text-ink">{r.user_email || r.user_id}</div>
                            <div className="text-xs text-ink-3">
                                Wants access to all workflows{r.note ? ` · ${r.note}` : ''} · {timeAgo(r.created_at)}
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <Badge tone="amber">pending</Badge>
                            <Button variant="primary" size="xs" onClick={() => decide(r.user_id, 'approve')}>Approve</Button>
                            <Button variant="outline" size="xs" onClick={() => decide(r.user_id, 'deny')}>Deny</Button>
                        </div>
                    </li>
                ))}
            </ul>
        </Card>
    );
}

// Same decide contract as the Users page — approve carries expiry + tier.
function ModelAccessTab({ pending, mutate }) {
    async function decide(id, actionName, validUntil, maxResolution = null) {
        const body = actionName === 'approve' ? { validUntil, maxResolution } : undefined;
        const r = await sendJson(`/api/admin/requests/${id}/${actionName}`, 'POST', body);
        const done = actionName === 'deny_upgrade' ? 'Upgrade declined — existing access unchanged' : `Request ${actionName}d`;
        r.ok ? (toast.success(done), mutate()) : toast.error(r.data?.error || r.data?.message || 'Failed');
    }
    if (!pending.length) {
        return <EmptyState icon={Inbox} title="No pending access requests" hint="Model and tool access requests appear here; granted access is managed on the Users page." />;
    }
    return (
        <Card>
            <ul className="space-y-2">
                {pending.map((r) => (
                    <PendingRequest key={r.id} r={r}
                        onApprove={(id, until, quality) => decide(id, 'approve', until, quality)}
                        onDeny={(id, upgrade) => decide(id, upgrade ? 'deny_upgrade' : 'revoke')} />
                ))}
            </ul>
        </Card>
    );
}

// Approve creates the project and adds the requester (idempotent server-side).
function ProjectsTab({ requests, mutate }) {
    const [decidingId, setDecidingId] = useState(null);
    async function decide(id, action) {
        setDecidingId(id);
        const r = await sendJson(`/api/admin/project-requests/${id}/${action}`, 'POST');
        setDecidingId(null);
        if (!r.ok) return toast.error(r.data?.error || 'Could not decide the request.');
        toast.success(action === 'approve' ? 'Project created — requester added' : 'Request declined');
        mutate();
    }
    if (!requests.length) {
        return <EmptyState icon={Inbox} title="No pending project requests" hint="Members ask for new projects from the studio; approving one creates it and adds them." />;
    }
    return (
        <Card>
            <ul className="divide-y divide-line/60">
                {requests.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                        <div className="min-w-0 text-sm">
                            <div className="font-medium text-ink">{r.name}</div>
                            <div className="text-xs text-ink-3">{r.user_email}{r.note ? ` · ${r.note}` : ''} · {timeAgo(r.created_at)}</div>
                        </div>
                        <div className="flex items-center gap-2">
                            <Button variant="primary" size="xs" disabled={decidingId === r.id} onClick={() => decide(r.id, 'approve')}>Approve</Button>
                            <Button variant="outline" size="xs" disabled={decidingId === r.id} onClick={() => decide(r.id, 'deny')}>Deny</Button>
                        </div>
                    </li>
                ))}
            </ul>
        </Card>
    );
}

// Same PATCH the Enhance Queue page uses for its access panel.
function ExrAccessTab({ requests, mutate }) {
    async function decide(requestId, action) {
        const r = await sendJson('/api/admin/exr-queue', 'PATCH', { requestId, action: action === 'approve' ? 'approve_access' : 'deny_access' });
        if (!r.ok) return toast.error(r.data?.error || 'Could not decide the EXR access request.');
        toast.success(action === 'approve' ? 'EXR access approved.' : 'EXR access request denied.');
        mutate();
    }
    if (!requests.length) {
        return <EmptyState icon={Inbox} title="No pending EXR access requests" hint="Users request EXR access from the studio, gallery, or the EXR tool page." />;
    }
    return (
        <Card>
            <ul className="divide-y divide-line/60">
                {requests.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                        <div className="min-w-0 text-sm">
                            <div className="font-medium text-ink">{r.user_email || r.user_id}</div>
                            <div className="text-xs text-ink-3">
                                Workspace: <span className="text-ink-2">{r.project_name || `Project ${r.project_id}`}</span>
                                {r.note ? ` · ${r.note}` : ''}
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <Badge tone="amber">pending</Badge>
                            <Button variant="primary" size="xs" onClick={() => decide(r.id, 'approve')}>Approve</Button>
                            <Button variant="outline" size="xs" onClick={() => decide(r.id, 'deny')}>Deny</Button>
                        </div>
                    </li>
                ))}
            </ul>
        </Card>
    );
}
