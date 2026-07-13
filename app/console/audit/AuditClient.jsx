'use client';

import { useState } from 'react';
import { PageHeader, Badge, Button, Input, DataTable, Modal, EmptyState } from '../ui.jsx';
import { useApi, fmtDate } from '../lib.js';
import { Download, ScrollText, Diff } from 'lucide-react';

const ACTION_TONE = (a) => (a.includes('revoke') || a.includes('remove') || a.includes('delete') || a.includes('pause') ? 'red'
    : a.includes('grant') || a.includes('allow') || a.includes('create') || a.includes('add') ? 'green' : 'blue');

export default function AuditClient() {
    const [actor, setActor] = useState('');
    const [action, setAction] = useState('');
    const [diff, setDiff] = useState(null);
    const qs = new URLSearchParams();
    if (actor) qs.set('actor', actor);
    if (action) qs.set('action', action);
    const { data, error } = useApi(`/api/admin/audit?${qs}`);

    const columns = [
        { accessorKey: 'created_at', header: 'When', cell: ({ getValue }) => <span className="font-mono text-ink-3">{fmtDate(getValue())}</span> },
        { accessorKey: 'actor_email', header: 'Actor', cell: ({ row }) => <span className="text-ink-2">{row.original.actor_email || row.original.actor_id}</span> },
        { accessorKey: 'action', header: 'Action', cell: ({ getValue }) => <Badge tone={ACTION_TONE(getValue())}>{getValue()}</Badge> },
        { accessorKey: 'target_type', header: 'Target', cell: ({ row }) => <span className="font-mono text-ink-3">{row.original.target_type} #{row.original.target_id}</span> },
        { accessorKey: 'reason', header: 'Reason', cell: ({ getValue }) => <span className="text-ink-3">{getValue() || '—'}</span> },
        { accessorKey: 'ip', header: 'IP', cell: ({ getValue }) => <span className="font-mono text-ink-3">{getValue() || '—'}</span> },
        {
            id: 'diff', header: '', enableSorting: false,
            cell: ({ row }) => (row.original.before || row.original.after)
                ? <Button variant="ghost" size="xs" onClick={() => setDiff(row.original)}><Diff size={13} /></Button>
                : null,
        },
    ];

    return (
        <div>
            <PageHeader title="Audit log" subtitle="Who did what, when, from where — insert-only, exportable">
                <Input className="w-44" placeholder="Filter by actor…" value={actor} onChange={(e) => setActor(e.target.value)} />
                <Input className="w-44" placeholder="Filter by action…" value={action} onChange={(e) => setAction(e.target.value)} />
                <a href={`/api/admin/audit?${qs}${qs.toString() ? '&' : ''}format=csv`}>
                    <Button variant="outline"><Download size={13} /> CSV</Button>
                </a>
            </PageHeader>
            {error?.code === 'FORBIDDEN'
                ? <EmptyState title="Requires audit.view" hint="The audit trail is visible to admins." />
                : (data?.items?.length
                    ? <DataTable columns={columns} data={data.items} searchable={false} pageSize={20} />
                    : <EmptyState icon={ScrollText} title="No audit entries match" hint="Every admin action (grants, revokes, budgets, keys, members, pauses) lands here automatically." />)}
            <Modal open={!!diff} onOpenChange={(o) => !o && setDiff(null)} title={`${diff?.action} — before / after`}>
                <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                        <div className="mb-1 font-medium text-danger">Before</div>
                        <pre className="max-h-64 overflow-auto rounded-lg bg-paper-0 p-2 font-mono text-danger/80">{JSON.stringify(diff?.before, null, 2) || '—'}</pre>
                    </div>
                    <div>
                        <div className="mb-1 font-medium text-ok">After</div>
                        <pre className="max-h-64 overflow-auto rounded-lg bg-paper-0 p-2 font-mono text-ok/80">{JSON.stringify(diff?.after, null, 2) || '—'}</pre>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
