'use client';

import toast from 'react-hot-toast';
import { PageHeader, Card, Badge, Button, DataTable, EmptyState } from '../ui.jsx';
import { useApi, sendJson, fmtDate } from '../lib.js';
import { Users, Shield, ShieldCheck, ShieldOff, UserX } from 'lucide-react';

// Platform users (Clerk mirror) + the existing model access-request queue.
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
    async function decide(id, actionName) {
        const r = await sendJson(`/api/admin/requests/${id}/${actionName}`, 'POST');
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

    const pending = (requests.data?.requests ?? []).filter((r) => r.status === 'pending');

    return (
        <div>
            <PageHeader title="Users" subtitle="Platform roles and pending model access requests" />
            {pending.length ? (
                <Card className="mb-4">
                    <div className="mb-2 text-sm font-medium text-ink-2">Access requests</div>
                    <ul className="space-y-2">
                        {pending.map((r) => (
                            <li key={r.id} className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm">
                                <span className="text-ink-2">{r.user_email} → <code className="font-mono text-xs text-ink-2">{r.model_id}</code></span>
                                <div className="flex gap-1.5">
                                    <Button variant="primary" size="xs" onClick={() => decide(r.id, 'approve')}>Approve</Button>
                                    <Button variant="outline" size="xs" onClick={() => decide(r.id, 'revoke')}>Deny</Button>
                                </div>
                            </li>
                        ))}
                    </ul>
                </Card>
            ) : null}
            {users.error
                ? <EmptyState icon={Users} title="Admin only" hint={users.error.message} />
                : <DataTable columns={columns} data={users.data?.users ?? []} />}
        </div>
    );
}
