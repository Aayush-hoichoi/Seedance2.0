'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { Badge, Button, DataTable, EmptyState, Modal, PageHeader, Select, StatCard } from '../ui.jsx';
import { useApi, sendJson, fmtDate, timeAgo } from '../lib.js';
import { downloadArchivedAsset } from '../../../lib/seedance/downloadAssets.js';
import { FileOutput } from 'lucide-react';

const STATUS_TONE = { queued: 'amber', processing: 'blue', succeeded: 'green', failed: 'red', rejected: 'red', cancelled: 'zinc' };

export default function ExrQueueClient() {
    const [kind, setKind] = useState('exr');
    const [status, setStatus] = useState('');
    const [selected, setSelected] = useState(null);
    const queue = useApi(`/api/admin/exr-queue${status ? `?status=${status}` : ''}`, { refreshInterval: 5000 });
    const upscaleTab = kind === 'upscale';
    const kindLabel = upscaleTab ? 'Upscale' : 'EXR';
    const items = (queue.data?.items ?? []).filter((job) => isUpscale(job) === upscaleTab);
    const counts = Object.fromEntries((queue.data?.counts ?? [])
        .filter((item) => Boolean(item.upscale) === upscaleTab)
        .map((item) => [item.status, item.count]));
    const accessRequests = (queue.data?.accessRequests ?? []).filter((request) => request.status === 'pending');
    const billing = selected?.request_body?._billing || null;

    // Ledger rows: every job that recorded billing details, following the same
    // status filter as the queue table. Older jobs without _billing are skipped.
    const ledgerRows = items
        .filter((job) => job.request_body?._billing)
        .map((job) => ({ ...job, billing: job.request_body._billing }));
    const totalSpendUsd = ledgerRows.reduce((sum, row) => sum + (Number(row.billing.estimatedCostUsd) || 0), 0);
    const totalMinutes = ledgerRows.reduce((sum, row) => sum + (Number(row.billing.durationSeconds) || 0), 0) / 60;

    // Freshest link for a job's output: re-presign the archived copy when one
    // exists (the stored BytePlus URL expires within days), else the stored URL.
    async function outputUrl(job) {
        const key = job.result?.archiveKey;
        if (key) {
            try {
                const response = await fetch(`/api/byteplus/archive?key=${encodeURIComponent(key)}`);
                const data = response.ok ? await response.json() : null;
                if (data?.url) return data.url;
            } catch { /* fall back to the stored URL */ }
        }
        return job.result?.url || null;
    }

    async function copyOutputLink(job) {
        const url = await outputUrl(job);
        if (!url) return toast.error('This job has no output link.');
        await navigator.clipboard.writeText(url);
        toast.success(job.result?.archiveKey ? 'Output link copied (valid 7 days).' : 'Output link copied (BytePlus URL — expires soon).');
    }

    function downloadOutput(job) {
        const up = job.request_body?._upscale;
        const name = up
            ? `${job.provider_task_id || jobLabel(job)}.${up.container || 'mp4'}`
            : `${job.provider_task_id || jobLabel(job)}-16bit.mov`;
        downloadArchivedAsset(job.result?.archiveKey, job.result?.url, name, job.provider_task_id, { raw: true });
        toast.success('Download started.');
    }

    function exportLedgerCsv() {
        const header = ['job', 'date', 'status', 'user', 'project', 'tier', 'resolution', 'fps', 'duration_seconds', 'rate_usd_per_minute', 'estimated_cost_usd'];
        const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
        const lines = ledgerRows.map((row) => [
            jobLabel(row), row.created_at, row.status,
            row.user_email || row.user_id, row.project_name || row.project_id || '',
            row.billing.tier || '', row.billing.resolution || '', row.billing.fps || '',
            row.billing.durationSeconds ?? '', row.billing.unitPriceUsd ?? '', row.billing.estimatedCostUsd ?? '',
        ].map(cell).join(','));
        const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${kind}-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }

    async function change(id, action) {
        const result = await sendJson('/api/admin/exr-queue', 'PATCH', { id, action });
        if (!result.ok) {
            toast.error(result.data?.error || `Could not ${action} the job.`);
            return;
        }
        toast.success(action === 'retry' ? 'Job queued again.' : action === 'rearchive' ? 'Archive queued again.' : 'Job cancelled.');
        setSelected(null);
        queue.mutate();
    }

    async function decideAccess(requestId, action) {
        const result = await sendJson('/api/admin/exr-queue', 'PATCH', { requestId, action: action === 'approve' ? 'approve_access' : 'deny_access' });
        if (!result.ok) {
            toast.error(result.data?.error || 'Could not decide the EXR access request.');
            return;
        }
        toast.success(action === 'approve' ? 'EXR access approved.' : 'EXR access request denied.');
        queue.mutate();
    }

    const columns = [
        { accessorKey: 'id', header: '#', cell: ({ row }) => <span className="font-mono tabular-nums text-ink-3">{jobLabel(row.original)}</span> },
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

    const ledgerColumns = [
        { accessorKey: 'id', header: '#', cell: ({ row }) => <span className="font-mono tabular-nums text-ink-3">{jobLabel(row.original)}</span> },
        { accessorKey: 'created_at', header: 'Date', cell: ({ getValue }) => <span className="font-mono text-xs text-ink-3" title={fmtDate(getValue())}>{timeAgo(getValue())}</span> },
        {
            id: 'owner', header: 'User / project',
            cell: ({ row }) => <div><div className="text-ink-2">{row.original.user_name || row.original.user_email || row.original.user_id}</div><div className="text-xs text-ink-3">{row.original.project_name || `Project ${row.original.project_id || '—'}`}</div></div>,
        },
        {
            id: 'spec', header: 'Output',
            cell: ({ row }) => <span className="text-xs text-ink-2">{[row.original.billing.resolution, row.original.billing.fps && `${row.original.billing.fps} FPS`, row.original.billing.tier].filter(Boolean).join(' · ') || '—'}</span>,
        },
        {
            id: 'duration', header: 'Length',
            cell: ({ row }) => <span className="font-mono tabular-nums text-xs text-ink-3">{row.original.billing.durationSeconds ? `${Number(row.original.billing.durationSeconds).toFixed(1)}s` : '—'}</span>,
        },
        {
            id: 'rate', header: 'Rate / min',
            cell: ({ row }) => <span className="font-mono tabular-nums text-xs text-ink-3">{row.original.billing.unitPriceUsd == null ? '—' : `$${Number(row.original.billing.unitPriceUsd).toFixed(4)}`}</span>,
        },
        {
            id: 'cost', header: 'Est. cost',
            cell: ({ row }) => <span className="font-mono tabular-nums font-semibold text-ink">{row.original.billing.estimatedCostUsd == null ? '—' : `$${Number(row.original.billing.estimatedCostUsd).toFixed(4)}`}</span>,
        },
        {
            accessorKey: 'status', header: 'Status',
            cell: ({ getValue }) => <Badge tone={STATUS_TONE[getValue()] || 'zinc'}>{getValue()}</Badge>,
        },
        {
            id: 'output', header: 'Output', enableSorting: false,
            cell: ({ row }) => (row.original.result?.url || row.original.result?.archiveKey) ? (
                <div className="flex items-center gap-1.5">
                    <Button variant="ghost" size="xs" title="Copy the output link" onClick={() => copyOutputLink(row.original)}>Copy link</Button>
                    <Button variant="ghost" size="xs" title="Download the generated output" onClick={() => downloadOutput(row.original)}>Download</Button>
                </div>
            ) : <span className="text-xs text-ink-3">—</span>,
        },
    ];

    return (
        <div>
            <PageHeader title="Enhance Queue" subtitle="BytePlus MediaKit jobs — EXR and Tools → Upscale — and worker state">
                <div className="flex items-center gap-1 rounded-lg border border-line bg-paper-2 p-1" role="tablist">
                    {['exr', 'upscale'].map((tab) => (
                        <button
                            key={tab} type="button" role="tab" aria-selected={kind === tab}
                            onClick={() => setKind(tab)}
                            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${kind === tab ? 'bg-paper-3 text-ink' : 'text-ink-3 hover:text-ink-2'}`}
                        >
                            {tab === 'exr' ? 'EXR' : 'Upscale'}
                        </button>
                    ))}
                </div>
                <Select value={status} onChange={(e) => setStatus(e.target.value)} title={`Filter ${kindLabel} jobs by status`}>
                    <option value="">All jobs</option>
                    <option value="queued">Queued</option>
                    <option value="processing">Processing</option>
                    <option value="succeeded">Succeeded</option>
                    <option value="failed">Failed</option>
                    <option value="rejected">Rejected</option>
                    <option value="cancelled">Cancelled</option>
                </Select>
            </PageHeader>

            {!upscaleTab && accessRequests.length > 0 && (
                <div className="mb-5 overflow-hidden rounded-lg border border-warn/30 bg-warn/5">
                    <div className="flex items-center justify-between border-b border-warn/20 px-4 py-2">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-warn">EXR access requests</div>
                        <Badge tone="amber">{accessRequests.length} pending</Badge>
                    </div>
                    <div className="divide-y divide-line/60">
                        {accessRequests.map((request) => (
                            <div key={request.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                                <div className="min-w-0 text-sm">
                                    <div className="font-medium text-ink">{request.user_email || request.user_id}</div>
                                    <div className="text-xs text-ink-3">
                                        Workspace: <span className="text-ink-2">{request.project_name || `Project ${request.project_id}`}</span>
                                        {request.note ? ` · ${request.note}` : ''}
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Button variant="primary" size="xs" onClick={() => decideAccess(request.id, 'approve')}>Approve</Button>
                                    <Button variant="outline" size="xs" onClick={() => decideAccess(request.id, 'deny')}>Deny</Button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-6">
                <StatCard label="Queued" value={counts.queued || 0} />
                <StatCard label="Processing" value={counts.processing || 0} tone="blue" />
                <StatCard label="Succeeded" value={counts.succeeded || 0} tone="green" />
                <StatCard label="Failed" value={counts.failed || 0} tone="red" />
                <StatCard label="Rejected" value={counts.rejected || 0} tone="red" />
                <StatCard label="Cancelled" value={counts.cancelled || 0} />
            </div>

            {items.length
                ? <DataTable columns={columns} data={items} pageSize={15} empty={`No ${kindLabel} jobs match this filter.`} />
                : <EmptyState icon={FileOutput} title={`No ${kindLabel} jobs`} hint={upscaleTab ? 'Upscale jobs appear here after a user submits one from Tools → Upscale.' : 'EXR jobs appear here after a user confirms an EXR request.'} />}

            <div className="mt-8">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h2 className="text-sm font-semibold text-ink">{kindLabel} generation ledger</h2>
                        <p className="text-xs text-ink-3">Billing record for every {kindLabel} job with recorded pricing{status ? ' (following the status filter above)' : ''}.</p>
                    </div>
                    {ledgerRows.length > 0 && <Button variant="outline" size="xs" onClick={exportLedgerCsv}>Export CSV</Button>}
                </div>
                <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
                    <StatCard label="Billed jobs" value={ledgerRows.length} />
                    <StatCard label="Video minutes" value={totalMinutes.toFixed(2)} tone="blue" />
                    <StatCard label="Estimated spend" value={`$${totalSpendUsd.toFixed(2)}`} tone="green" />
                </div>
                {ledgerRows.length
                    ? <DataTable columns={ledgerColumns} data={ledgerRows} pageSize={15} empty={`No billed ${kindLabel} jobs match this filter.`} />
                    : <EmptyState icon={FileOutput} title={`No billed ${kindLabel} jobs`} hint={`Jobs appear in the ledger once they carry billing details (all new ${kindLabel} requests do).`} />}
            </div>

            {selected && (
                <Modal
                    open={Boolean(selected)}
                    onOpenChange={(open) => { if (!open) setSelected(null); }}
                    title={`${jobLabel(selected)} details`}
                    className="max-h-[90vh] w-[min(94vw,880px)] overflow-y-auto sm:max-w-[880px]"
                    footer={(
                    <>
                        {(selected.status === 'queued' || selected.status === 'processing') && <Button variant="danger" onClick={() => change(selected.id, 'cancel')}>Cancel job</Button>}
                        {(selected.status === 'failed' || selected.status === 'cancelled') && !isUpscale(selected) && <Button variant="primary" onClick={() => change(selected.id, 'retry')}>Retry job</Button>}
                        {selected.status === 'succeeded' && selected.result?.durable === false && selected.result?.url && <Button variant="outline" onClick={() => change(selected.id, 'rearchive')}>Archive again</Button>}
                    </>
                    )}
                >
                    <div className="space-y-3 text-xs">
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            <div><div className="text-ink-3">Status</div><div className="mt-1"><Badge tone={STATUS_TONE[selected.status] || 'zinc'}>{selected.status}</Badge></div></div>
                            <div><div className="text-ink-3">Created</div><div className="mt-1 text-ink-2">{fmtDate(selected.created_at)}</div></div>
                            <div><div className="text-ink-3">User</div><div className="mt-1 break-all text-ink-2">{selected.user_email || selected.user_id}</div></div>
                            <div><div className="text-ink-3">Project</div><div className="mt-1 break-words text-ink-2">{selected.project_name || selected.project_id || '—'}</div></div>
                            <div><div className="text-ink-3">Provider task</div><div className="mt-1 break-all font-mono text-ink-2">{selected.provider_task_id || 'Not submitted yet'}</div></div>
                            <div><div className="text-ink-3">Provider request</div><div className="mt-1 break-all font-mono text-ink-2">{selected.provider_request_id || '—'}</div></div>
                        </div>
                        <div><div className="text-ink-3">Source URL</div><div className="mt-1 max-h-20 overflow-auto break-all rounded-md bg-paper-3 p-2 font-mono text-[10px] leading-relaxed text-ink-2">{selected.source_url}</div></div>
                        <div className="rounded-md border border-line bg-paper-2 p-3">
                            <div className="font-semibold text-ink">Billing details</div>
                            {billing ? (
                                <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4">
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
                        <div className="grid min-w-0 gap-3 lg:grid-cols-2">
                            <div className="min-w-0"><div className="text-ink-3">Request settings</div><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-paper-3 p-3 text-[10px] leading-relaxed text-ink-2">{JSON.stringify(selected.request_body, null, 2)}</pre></div>
                            {selected.result && <div className="min-w-0"><div className="text-ink-3">Result</div><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-paper-3 p-3 text-[10px] leading-relaxed text-ink-2">{JSON.stringify(selected.result, null, 2)}</pre></div>}
                        </div>
                        {selected.error && <div><div className="text-ink-3">Error</div><pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-md bg-danger/10 p-3 text-[10px] leading-relaxed text-danger">{JSON.stringify(selected.error, null, 2)}</pre></div>}
                    </div>
                </Modal>
            )}
        </div>
    );
}

// Upscale (Tools) jobs share this queue; they are budgeted per job, so a
// failed one is resubmitted by the user rather than retried here.
function isUpscale(job) {
    return Boolean(job?.request_body?._upscale);
}
function jobLabel(job) {
    return `${isUpscale(job) ? 'UPS' : 'EXR'}-${job.id}`;
}
