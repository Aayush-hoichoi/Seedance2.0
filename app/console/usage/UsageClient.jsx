'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { PageHeader, Card, Select, Button, DataTable } from '../ui.jsx';
import { useApi, fmtUsd, fmtInt, monthStartIso, dayStartIso } from '../lib.js';
import { Download } from 'lucide-react';

const SpendArea = dynamic(() => import('../charts.jsx').then((m) => m.SpendArea), { ssr: false });
const TopBars = dynamic(() => import('../charts.jsx').then((m) => m.TopBars), { ssr: false });

const GROUPS = ['project', 'user', 'model', 'provider', 'day'];
const WINDOWS = { today: dayStartIso, month: monthStartIso, all: () => '' };

// Usage explorer: any dimension × any window, chart + table + CSV.
export default function UsageClient() {
    const [groupBy, setGroupBy] = useState('model');
    const [window, setWindow] = useState('month');
    const from = WINDOWS[window]();
    const url = `/api/orgs/usage?group_by=${groupBy}${from ? `&from=${from}` : ''}`;
    const { data, error } = useApi(url);
    const items = (data?.items ?? []).map((r) => ({ ...r, cost_usd: Number(r.cost_usd), video_seconds: Number(r.video_seconds) }));

    const columns = [
        { accessorKey: 'key', header: groupBy, cell: ({ getValue }) => <span className="font-medium text-ink">{String(getValue() ?? '—')}</span> },
        { accessorKey: 'generations', header: 'Generations', cell: ({ getValue }) => fmtInt(getValue()) },
        { accessorKey: 'failures', header: 'Failures', cell: ({ getValue }) => <span className={Number(getValue()) ? 'font-mono tabular-nums text-danger' : 'font-mono tabular-nums text-ink-3'}>{fmtInt(getValue())}</span> },
        { accessorKey: 'video_seconds', header: 'Video sec', cell: ({ getValue }) => fmtInt(getValue()) },
        { accessorKey: 'images', header: 'Images', cell: ({ getValue }) => fmtInt(getValue()) },
        { accessorKey: 'cost_usd', header: 'Cost', cell: ({ getValue }) => <span className="font-mono tabular-nums text-ink">{fmtUsd(getValue())}</span> },
    ];

    return (
        <div>
            <PageHeader title="Usage" subtitle="Every settlement is an immutable billing event — slice it any way">
                <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                    {GROUPS.map((g) => <option key={g} value={g}>by {g}</option>)}
                </Select>
                <Select value={window} onChange={(e) => setWindow(e.target.value)}>
                    <option value="today">today</option>
                    <option value="month">this month</option>
                    <option value="all">all time</option>
                </Select>
                <a href={`${url}${url.includes('?') ? '&' : '?'}format=csv`}>
                    <Button variant="outline"><Download size={13} /> CSV</Button>
                </a>
            </PageHeader>
            {error?.code === 'FORBIDDEN'
                ? <Card className="text-sm text-ink-2">Org-wide usage is admin-only — project members can see their project’s usage on the project page.</Card>
                : (
                    <>
                        <Card className="mb-4">
                            {items.length
                                ? (groupBy === 'day'
                                    ? <SpendArea data={items.slice().sort((a, b) => (a.key < b.key ? -1 : 1))} height={240} />
                                    : <TopBars data={items.slice(0, 10)} height={240} />)
                                : <div className="grid h-[240px] place-items-center text-xs text-ink-3">No settled usage in this window</div>}
                        </Card>
                        <DataTable columns={columns} data={items} searchable={items.length > 8} />
                    </>
                )}
        </div>
    );
}
