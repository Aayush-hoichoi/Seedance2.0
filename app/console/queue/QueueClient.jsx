'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { PageHeader, Badge, Button, Select, DataTable, EmptyState } from '../ui.jsx';
import { useApi, sendJson, fmtDate, timeAgo, fmtUsd, STATUS_TONE } from '../lib.js';
import { useEvents } from '../../hooks/useEvents.js';
import { ListOrdered, XCircle } from 'lucide-react';

// Live queue: SSE-updated jobs table with cancel + per-project pause.
export default function QueueClient() {
    const projects = useApi('/api/projects');
    const [projectId, setProjectId] = useState('');
    const [category, setCategory] = useState(''); // '' = all | 'video' | 'image'
    const activeProject = projectId || projects.data?.items?.[0]?.id;
    const jobs = useApi(
        activeProject ? `/api/generations?projectId=${activeProject}&scope=project${category ? `&category=${category}` : ''}` : null,
        { refreshInterval: 15000 },
    );

    useEvents('job.status_changed', () => jobs.mutate());

    async function cancel(id) {
        const r = await sendJson(`/api/generations/${id}`, 'DELETE');
        r.ok ? (toast.success(`Generation #${id} cancelled`), jobs.mutate()) : toast.error(r.data?.message || 'Cancel failed');
    }

    const items = jobs.data?.items ?? [];
    const columns = [
        { accessorKey: 'id', header: '#', cell: ({ getValue }) => <span className="font-mono tabular-nums text-ink-3">#{getValue()}</span> },
        { accessorKey: 'model_id', header: 'Model' },
        { accessorKey: 'user_id', header: 'User', cell: ({ getValue }) => <span className="font-mono text-ink-2">{String(getValue()).slice(0, 16)}…</span> },
        {
            accessorKey: 'status', header: 'Status',
            cell: ({ row, getValue }) => {
                const status = getValue();
                // Provider rejections (moderation, activation, quota) land in
                // jobs.error — show the reason so a failed row explains itself.
                const reason = status === 'failed' ? row.original.error?.message?.replace(/\s*Request id:.*$/i, '') : null;
                return (
                    <div className="max-w-[26rem]">
                        <Badge tone={STATUS_TONE[status] || 'zinc'}>{status}</Badge>
                        {reason ? <div className="mt-1 truncate text-xs text-danger/70" title={row.original.error.message}>{reason}</div> : null}
                    </div>
                );
            },
        },
        { accessorKey: 'priority', header: 'Priority', cell: ({ getValue }) => <span className={getValue() === 'interactive' ? 'text-accent-hi' : 'text-ink-3'}>{getValue()}</span> },
        { accessorKey: 'attempt', header: 'Attempt', cell: ({ getValue }) => <span className="font-mono tabular-nums text-ink-3">{getValue()}/3</span> },
        {
            id: 'wait', header: 'Waited',
            cell: ({ row }) => {
                const j = row.original;
                const from = new Date(j.created_at).getTime();
                const to = j.started_at ? new Date(j.started_at).getTime() : Date.now();
                return <span className="font-mono tabular-nums text-ink-3">{Math.max(0, Math.round((to - from) / 1000))}s</span>;
            },
        },
        { accessorKey: 'created_at', header: 'Submitted', cell: ({ getValue }) => <span className="font-mono text-ink-3" title={fmtDate(getValue())}>{timeAgo(getValue())}</span> },
        {
            id: 'cost', header: 'Est. cost',
            cell: ({ row }) => <span className="font-mono tabular-nums text-ink-2">{fmtUsd(row.original.request_body?.est_cost_usd)}</span>,
        },
        {
            id: 'actions', header: '', enableSorting: false,
            cell: ({ row }) => ['queued', 'running'].includes(row.original.status)
                ? <Button variant="ghost" size="xs" onClick={() => cancel(row.original.id)} title="Cancel"><XCircle size={14} className="text-danger" /></Button>
                : null,
        },
    ];

    const queued = items.filter((j) => j.status === 'queued').length;
    const running = items.filter((j) => j.status === 'running').length;

    return (
        <div>
            <PageHeader title="Queue" subtitle={`${queued} queued · ${running} running — updates live over SSE`}>
                <Select value={category} onChange={(e) => setCategory(e.target.value)} title="Filter by media type">
                    <option value="">All media</option>
                    <option value="video">Video</option>
                    <option value="image">Image</option>
                </Select>
                <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                    {(projects.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
            </PageHeader>
            {items.length
                ? <DataTable columns={columns} data={items} pageSize={15} empty="Queue is empty." />
                : <EmptyState icon={ListOrdered} title="Queue is empty" hint="Jobs appear here the moment anyone submits a generation — with priority, retries and fair scheduling." />}
        </div>
    );
}
