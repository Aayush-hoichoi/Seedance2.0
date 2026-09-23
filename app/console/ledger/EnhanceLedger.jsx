'use client';

// The EXR / Upscale billing ledger — one kind at a time, fed by the same
// admin queue endpoint the Enhance Queue page uses. Lives on the Ledger page
// so every money record is read in one place.

import toast from 'react-hot-toast';
import { FileOutput } from 'lucide-react';
import { Badge, Button, DataTable, EmptyState, StatCard } from '../ui.jsx';
import { useApi, fmtDate, timeAgo } from '../lib.js';
import { downloadArchivedAsset } from '../../../lib/seedance/downloadAssets.js';

const STATUS_TONE = { queued: 'amber', processing: 'blue', succeeded: 'green', failed: 'red', rejected: 'red', cancelled: 'zinc' };

export default function EnhanceLedger({ kind }) {
    const upscale = kind === 'upscale';
    const kindLabel = upscale ? 'Upscale' : 'EXR';
    const queue = useApi('/api/admin/exr-queue', { refreshInterval: 20_000, keepPreviousData: true, revalidateOnFocus: true });

    const rows = (queue.data?.items ?? [])
        .filter((job) => Boolean(job.request_body?._upscale) === upscale && job.request_body?._billing)
        .map((job) => ({ ...job, billing: job.request_body._billing }));
    const totalSpendUsd = rows.reduce((sum, row) => sum + (Number(row.billing.estimatedCostUsd) || 0), 0);
    const totalMinutes = rows.reduce((sum, row) => sum + (Number(row.billing.durationSeconds) || 0), 0) / 60;

    const jobLabel = (job) => `${upscale ? 'UPS' : 'EXR'}-${job.id}`;

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

    function exportCsv() {
        const header = ['job', 'date', 'status', 'user', 'project', 'tier', 'resolution', 'fps', 'duration_seconds', 'rate_usd_per_minute', 'estimated_cost_usd'];
        const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
        const lines = rows.map((row) => [
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

    const columns = [
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
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="text-sm font-semibold text-ink">{kindLabel} generation ledger</h2>
                    <p className="text-xs text-ink-3">Billing record for every {kindLabel} job with recorded pricing.</p>
                </div>
                {rows.length > 0 && <Button variant="outline" size="xs" onClick={exportCsv}>Export CSV</Button>}
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <StatCard label="Billed jobs" value={rows.length} />
                <StatCard label="Video minutes" value={totalMinutes.toFixed(2)} tone="blue" />
                <StatCard label="Estimated spend" value={`$${totalSpendUsd.toFixed(2)}`} tone="green" />
            </div>
            {rows.length
                ? <DataTable columns={columns} data={rows} pageSize={15} empty={`No billed ${kindLabel} jobs.`} />
                : <EmptyState icon={FileOutput} title={`No billed ${kindLabel} jobs`} hint={`Jobs appear here once they carry billing details (all new ${kindLabel} requests do).`} />}
        </div>
    );
}
