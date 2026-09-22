'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { Badge, Button, DataTable, EmptyState, Modal, PageHeader, Select, StatCard } from '../ui.jsx';
import { useApi, sendJson, fmtDate, timeAgo } from '../lib.js';
import { FileOutput } from 'lucide-react';

const STATUS_TONE = { queued: 'amber', processing: 'blue', succeeded: 'green', failed: 'red', cancelled: 'zinc' };

export default function ExrQueueClient() {
    const [status, setStatus] = useState('');
    const [selected, setSelected] = useState(null);
    const queue = useApi(`/api/admin/exr-queue${status ? `?status=${status}` : ''}`, { refreshInterval: 5000 });
    const items = queue.data?.items ?? [];
    const counts = Object.fromEntries((queue.data?.counts ?? []).map((item) => [item.status, item.count]));
    const billing = selected?.request_body?._billing || null;

    async function change(id, action) {
        const result = await sendJson('/api/admin/exr-queue', 'PATCH', { id, action });
        if (!result.ok) {
            toast.error(result.data?.error || `Could not ${action} EXR job.`);
            return;
        }
        toast.success(action === 'retry' ? 'EXR job queued again.' : 'EXR job cancelled.');
        setSelected(null);
        queue.mutate();
    }

    const columns = [
        { accessorKey: 'id', header: '#', cell: ({ getValue }) => <span className="font-mono tabular-nums text-ink-3">EXR-{getValue()}</span> },
        {
            accessorKey: 'status', header: 'Status',
            cell: ({ getValue }) => <Badge tone={STATUS_TONE[getValue()] || 'zinc'}>{getValue()}</Badge>,
        },
        {
            id: 'owner', header: 'User / project',
            cell: ({ row }) => <div><div className="text-ink-2">{row.original.user_name || row.original.user_email || row.original.user_id}</div><div className="text-xs text-ink-3">{row.original.project_name || `Project ${row.original.project_id || '—'}`}</div></div>,
        },
        { accessorKey: 'attempt', header: 'Attempts', cell: ({ getValue }) => <span className="font-mono tabular-nums text-ink-3">{getValue()}/3</span> },
        { accessorKey: 'provider_task_id', header: 'Provider task', cell: ({ getValue }) => <span className="max-w-48 truncate font-mono text-xs text-ink-3" title={getValue() || ''}>{getValue() || '—'}</span> },
        { accessorKey: 'created_at', header: 'Created', cell: ({ getValue }) => <span className="font-mono text-xs text-ink-3" title={fmtDate(getValue())}>{timeAgo(getValue())}</span> },
        {
            id: 'actions', header: '', enableSorting: false,
            cell: ({ row }) => <Button variant="ghost" size="xs" onClick={() => setSelected(row.original)}>Inspect</Button>,
        },
    ];

    return (
        <div>
            <PageHeader title="EXR Queue" subtitle="Dedicated BytePlus MediaKit enhancement jobs and worker state">
                <Select value={status} onChange={(e) => setStatus(e.target.value)} title="Filter EXR jobs by status">
                    <option value="">All jobs</option>
                    <option value="queued">Queued</option>
                    <option value="processing">Processing</option>
                    <option value="succeeded">Succeeded</option>
                    <option value="failed">Failed</option>
                    <option value="cancelled">Cancelled</option>
                </Select>
            </PageHeader>

            <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
                <StatCard label="Queued" value={counts.queued || 0} />
                <StatCard label="Processing" value={counts.processing || 0} tone="blue" />
                <StatCard label="Succeeded" value={counts.succeeded || 0} tone="green" />
                <StatCard label="Failed" value={counts.failed || 0} tone="red" />
                <StatCard label="Cancelled" value={counts.cancelled || 0} />
            </div>

            {items.length
                ? <DataTable columns={columns} data={items} pageSize={15} empty="No EXR jobs match this filter." />
                : <EmptyState icon={FileOutput} title="No EXR jobs" hint="EXR jobs appear here after a user confirms an EXR request." />}

            {selected && (
                <Modal open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null); }} title={`EXR-${selected.id} details`} footer={(
                    <>
                        {(selected.status === 'queued' || selected.status === 'processing') && <Button variant="danger" onClick={() => change(selected.id, 'cancel')}>Cancel job</Button>}
                        {(selected.status === 'failed' || selected.status === 'cancelled') && <Button variant="primary" onClick={() => change(selected.id, 'retry')}>Retry job</Button>}
                    </>
                )}>
                    <div className="space-y-3 text-xs">
                        <div className="grid grid-cols-2 gap-3">
                            <div><div className="text-ink-3">Status</div><div className="mt-1"><Badge tone={STATUS_TONE[selected.status] || 'zinc'}>{selected.status}</Badge></div></div>
                            <div><div className="text-ink-3">Created</div><div className="mt-1 text-ink-2">{fmtDate(selected.created_at)}</div></div>
                            <div><div className="text-ink-3">User</div><div className="mt-1 break-all text-ink-2">{selected.user_email || selected.user_id}</div></div>
                            <div><div className="text-ink-3">Project</div><div className="mt-1 text-ink-2">{selected.project_name || selected.project_id || '—'}</div></div>
                            <div><div className="text-ink-3">Provider task</div><div className="mt-1 break-all font-mono text-ink-2">{selected.provider_task_id || 'Not submitted yet'}</div></div>
                            <div><div className="text-ink-3">Provider request</div><div className="mt-1 break-all font-mono text-ink-2">{selected.provider_request_id || '—'}</div></div>
                        </div>
                        <div><div className="text-ink-3">Source URL</div><div className="mt-1 max-h-20 overflow-auto break-all rounded-md bg-paper-3 p-2 font-mono text-[10px] text-ink-2">{selected.source_url}</div></div>
                        <div className="rounded-md border border-line bg-paper-2 p-3">
                            <div className="font-semibold text-ink">Billing details</div>
                            {billing ? (
                                <div className="mt-2 grid grid-cols-2 gap-3">
                                    <div><div className="text-ink-3">Tier</div><div className="mt-1 text-ink-2">{billing.tier || '—'}</div></div>
                                    <div><div className="text-ink-3">Resolution</div><div className="mt-1 text-ink-2">{billing.resolution || '—'}</div></div>
                                    <div><div className="text-ink-3">Frame rate</div><div className="mt-1 text-ink-2">{billing.fps ? `${billing.fps} FPS` : '—'}</div></div>
                                    <div><div className="text-ink-3">Bit depth</div><div className="mt-1 text-ink-2">{billing.bitDepth ? `${billing.bitDepth}-bit` : '—'}</div></div>
                                    <div><div className="text-ink-3">Format</div><div className="mt-1 text-ink-2">{billing.outputFormat || '—'}</div></div>
                                    <div><div className="text-ink-3">Video length</div><div className="mt-1 text-ink-2">{billing.durationSeconds ? `${Number(billing.durationSeconds).toFixed(3)} seconds` : 'Unavailable'}</div></div>
                                    <div><div className="text-ink-3">Rate</div><div className="mt-1 text-ink-2">{billing.unitPriceUsd == null ? '—' : `$${Number(billing.unitPriceUsd).toFixed(4)} / minute`}</div></div>
                                    <div><div className="text-ink-3">Estimated total</div><div className="mt-1 font-semibold text-ink">{billing.estimatedCostUsd == null ? 'Unavailable' : `$${Number(billing.estimatedCostUsd).toFixed(4)}`}</div></div>
                                </div>
                            ) : <p className="mt-1 text-ink-3">Billing details were not recorded for this older job.</p>}
                        </div>
                        <div><div className="text-ink-3">Request settings</div><pre className="mt-1 max-h-40 overflow-auto rounded-md bg-paper-3 p-2 text-[10px] text-ink-2">{JSON.stringify(selected.request_body, null, 2)}</pre></div>
                        {selected.result && <div><div className="text-ink-3">Result</div><pre className="mt-1 max-h-40 overflow-auto rounded-md bg-paper-3 p-2 text-[10px] text-ink-2">{JSON.stringify(selected.result, null, 2)}</pre></div>}
                        {selected.error && <div><div className="text-ink-3">Error</div><pre className="mt-1 max-h-28 overflow-auto rounded-md bg-danger/10 p-2 text-[10px] text-danger">{JSON.stringify(selected.error, null, 2)}</pre></div>}
                    </div>
                </Modal>
            )}
        </div>
    );
}
