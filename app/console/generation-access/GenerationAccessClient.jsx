'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { PageHeader, Card, Badge, Button, DataTable, EmptyState } from '../ui.jsx';
import { useApi, sendJson, fmtDate } from '../lib.js';
import { PauseCircle, PlayCircle, Users } from 'lucide-react';

export default function GenerationAccessClient() {
    const users = useApi('/api/admin/users');
    const [pausedOnly, setPausedOnly] = useState(false);
    const [pendingId, setPendingId] = useState(null);
    const allUsers = users.data?.users ?? [];
    const pausedCount = allUsers.filter((user) => user.generation_paused).length;
    const rows = allUsers.filter((user) => !pausedOnly || user.generation_paused);

    async function toggle(user) {
        const generationPaused = !user.generation_paused;
        setPendingId(user.id);
        const result = await sendJson(`/api/admin/users/${user.id}`, 'PATCH', { generationPaused });
        setPendingId(null);
        if (!result.ok) return toast.error(result.data?.error || result.data?.message || 'Could not update generation access');
        toast.success(generationPaused ? `Generation paused for ${user.email || user.name}` : `Generation restored for ${user.email || user.name}`);
        users.mutate();
    }

    const columns = [
        {
            accessorKey: 'email', header: 'Account',
            cell: ({ row }) => <div>
                <div className="font-medium text-ink">{row.original.name || row.original.email || row.original.id}</div>
                <div className="text-xs text-ink-3">{row.original.email || row.original.id}</div>
            </div>,
        },
        { accessorKey: 'role', header: 'Role', cell: ({ getValue }) => <span className="text-ink-2">{getValue() || 'member'}</span> },
        {
            accessorKey: 'generation_paused', header: 'Generation',
            cell: ({ getValue }) => getValue() ? <Badge tone="red">paused</Badge> : <Badge tone="green">active</Badge>,
        },
        { accessorKey: 'last_at', header: 'Last generation', cell: ({ getValue }) => <span className="font-mono text-xs text-ink-3">{getValue() ? fmtDate(getValue()) : '—'}</span> },
        {
            id: 'action', header: '', enableSorting: false,
            cell: ({ row }) => {
                const user = row.original;
                const isPending = pendingId === user.id;
                return user.generation_paused
                    ? <Button variant="outline" size="xs" loading={isPending} onClick={() => toggle(user)}><PlayCircle size={13} /> Resume</Button>
                    : <Button variant="danger" size="xs" loading={isPending} onClick={() => toggle(user)}><PauseCircle size={13} /> Pause generation</Button>;
            },
        },
    ];

    return (
        <div className="min-w-0 max-w-full">
            <PageHeader title="Generation access" subtitle="Pause an account across every project, or restore generation when access should resume." />
            {users.error ? <EmptyState icon={Users} title="Admin only" hint={users.error.message} /> : (
                <Card>
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <div className="text-sm font-medium text-ink">{pausedOnly ? 'Paused accounts' : 'All accounts'}</div>
                            <div className="mt-0.5 text-xs text-ink-3">{pausedCount} paused · {allUsers.length} accounts</div>
                        </div>
                        <div className="flex gap-1 rounded-lg border border-line p-1">
                            <Button size="xs" variant={!pausedOnly ? 'primary' : 'ghost'} onClick={() => setPausedOnly(false)}>All users</Button>
                            <Button size="xs" variant={pausedOnly ? 'primary' : 'ghost'} onClick={() => setPausedOnly(true)}>Paused ({pausedCount})</Button>
                        </div>
                    </div>
                    <DataTable columns={columns} data={rows} searchable empty={pausedOnly ? 'No paused accounts.' : 'No accounts found.'} />
                </Card>
            )}
        </div>
    );
}
