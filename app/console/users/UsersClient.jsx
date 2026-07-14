'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { PageHeader, Card, Badge, Button, DataTable, EmptyState } from '../ui.jsx';
import { useApi, sendJson, fmtDate } from '../lib.js';
import { Users, Shield, ShieldCheck, ShieldOff, UserX } from 'lucide-react';

// A Date → the value a <input type="datetime-local"> expects (local wall-clock).
function toLocalInput(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// One pending request: an expiry is required before Approve enables. Presets
// set the datetime; a custom time can be typed. Deny needs no time.
function PendingRequest({ r, onApprove, onDeny }) {
    const [until, setUntil] = useState('');
    const preset = (days) => setUntil(toLocalInput(new Date(Date.now() + days * 86400000)));
    return (
        <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-sm">
            <span className="text-ink-2">{r.user_email} → <code className="font-mono text-xs text-ink-2">{r.model_id}</code></span>
            <div className="flex flex-wrap items-center gap-1.5">
                {[7, 30, 90].map((d) => (
                    <button key={d} type="button" onClick={() => preset(d)}
                        className="rounded border border-line px-1.5 py-0.5 text-xs text-ink-3 transition-colors hover:border-accent hover:text-accent-hi">
                        {d}d
                    </button>
                ))}
                <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)}
                    className="rounded border border-line bg-paper-3 px-2 py-1 text-xs text-ink" />
                <Button variant="primary" size="xs" disabled={!until} title={until ? 'Approve until this time' : 'Pick an expiry first'}
                    onClick={() => onApprove(r.id, new Date(until).toISOString())}>Approve</Button>
                <Button variant="outline" size="xs" onClick={() => onDeny(r.id)}>Deny</Button>
            </div>
        </li>
    );
}

// Platform users (Clerk mirror) + the model access-request queue + active grants.
export default function UsersClient() {
    const users = useApi('/api/admin/users');
    const requests = useApi('/api/admin/requests');

    async function setRole(id, role) {
        const r = await sendJson(`/api/admin/users/${id}`, 'PATCH', { role });
        r.ok ? (toast.success(`Role set to ${role || 'member'}`), users.mutate()) : toast.error(r.data?.error || r.data?.message || 'Failed');
    }
    async function removeUser(id) {
        if (!window.confirm('Remove this user from the platform? Their Clerk account is deleted.')) return;
        const r = await sendJson(`/api/admin/users/${id}`, 'DELETE');
        r.ok ? (toast.success('User removed'), users.mutate()) : toast.error(r.data?.error || r.data?.message || 'Failed');
    }
    async function decide(id, actionName, validUntil) {
        const body = actionName === 'approve' ? { validUntil } : undefined;
        const r = await sendJson(`/api/admin/requests/${id}/${actionName}`, 'POST', body);
        r.ok ? (toast.success(`Request ${actionName}d`), requests.mutate()) : toast.error(r.data?.error || r.data?.message || 'Failed');
    }

    const me = users.data?.me;
    const columns = [
        { accessorKey: 'email', header: 'User', cell: ({ row }) => <span className="text-ink">{row.original.email || row.original.name || row.original.id}</span> },
        {
            accessorKey: 'role', header: 'Role',
            cell: ({ getValue }) => {
                const r = getValue();
                return r === 'admin' ? <Badge tone="violet">admin</Badge>
                    : r === 'manager' ? <Badge tone="blue">manager</Badge>
                        : <Badge tone="zinc">member</Badge>;
            },
        },
        { accessorKey: 'created_at', header: 'Joined', cell: ({ getValue }) => <span className="font-mono text-ink-3">{fmtDate(getValue())}</span> },
        {
            id: 'actions', header: '', enableSorting: false,
            cell: ({ row }) => {
                const u = row.original;
                if (u.id === me) return <span className="text-xs text-ink-3">you</span>;
                return (
                    <div className="flex items-center justify-end gap-1">
                        {u.role !== 'admin' && (
                            <Button variant="ghost" size="xs" title="Make admin" onClick={() => setRole(u.id, 'admin')}><ShieldCheck size={13} className="text-ok" /></Button>
                        )}
                        {u.role !== 'manager' && (
                            <Button variant="ghost" size="xs" title="Make manager" onClick={() => setRole(u.id, 'manager')}><Shield size={13} className="text-accent-hi" /></Button>
                        )}
                        {(u.role === 'admin' || u.role === 'manager') && (
                            <Button variant="ghost" size="xs" title="Make member" onClick={() => setRole(u.id, null)}><ShieldOff size={13} className="text-warn" /></Button>
                        )}
                        <Button variant="ghost" size="xs" title="Remove from platform" onClick={() => removeUser(u.id)}><UserX size={13} className="text-danger" /></Button>
                    </div>
                );
            },
        },
    ];

    const all = requests.data?.requests ?? [];
    const pending = all.filter((r) => r.status === 'pending');
    const now = Date.now();
    const granted = all.filter((r) => r.status === 'approved' && (!r.expires_at || new Date(r.expires_at).getTime() > now));

    const grantColumns = [
        { accessorKey: 'user_email', header: 'User', cell: ({ getValue, row }) => <span className="text-ink">{getValue() || row.original.user_id}</span> },
        { accessorKey: 'model_id', header: 'Model', cell: ({ getValue }) => <code className="rounded bg-paper-3 px-1.5 py-0.5 font-mono text-xs text-ink-2">{getValue()}</code> },
        { accessorKey: 'expires_at', header: 'Expires', cell: ({ getValue }) => (getValue() ? <span className="font-mono text-ink-2">{fmtDate(getValue())}</span> : <span className="text-ink-3">never</span>) },
        { accessorKey: 'decided_by', header: 'Granted by', cell: ({ getValue }) => <span className="text-ink-3">{getValue() || '—'}</span> },
        { id: 'revoke', header: '', enableSorting: false, cell: ({ row }) => <Button variant="ghost" size="xs" title="Revoke access" onClick={() => decide(row.original.id, 'revoke')}><span className="text-danger">Revoke</span></Button> },
    ];

    return (
        <div>
            <PageHeader title="Users" subtitle="Platform roles, model-access grants and pending requests" />

            {pending.length ? (
                <Card className="mb-4">
                    <div className="mb-2 text-sm font-medium text-ink-2">Pending access requests</div>
                    <ul className="space-y-2">
                        {pending.map((r) => (
                            <PendingRequest key={r.id} r={r}
                                onApprove={(id, until) => decide(id, 'approve', until)}
                                onDeny={(id) => decide(id, 'revoke')} />
                        ))}
                    </ul>
                </Card>
            ) : null}

            <div className="mb-5">
                <div className="mb-2 text-sm font-medium text-ink-2">Model access granted</div>
                {granted.length
                    ? <DataTable columns={grantColumns} data={granted} searchable={granted.length > 8} />
                    : <Card className="text-sm text-ink-3">No active model-access grants. Gated models unlock when you approve a request above.</Card>}
            </div>

            {users.error
                ? <EmptyState icon={Users} title="Admin only" hint={users.error.message} />
                : <DataTable columns={columns} data={users.data?.users ?? []} />}
        </div>
    );
}
