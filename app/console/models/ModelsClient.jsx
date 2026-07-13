'use client';

import { PageHeader, Card, Badge, DataTable, EmptyState } from '../ui.jsx';
import { useApi, fmtUsd, monthStartIso } from '../lib.js';
import { Boxes } from 'lucide-react';

// Catalog view: alias → current version → provider routes, with month spend.
export default function ModelsClient() {
    const projects = useApi('/api/projects');
    const firstProject = projects.data?.items?.[0]?.id;
    const catalog = useApi(firstProject ? `/api/models?projectId=${firstProject}` : null);
    const spend = useApi(`/api/orgs/usage?group_by=model&from=${monthStartIso()}`);

    const spendBy = Object.fromEntries((spend.data?.items ?? []).map((r) => [r.key, r.cost_usd]));
    const items = (catalog.data?.items ?? []).map((m) => ({ ...m, month_spend: Number(spendBy[m.id] || 0) }));

    const columns = [
        { accessorKey: 'displayName', header: 'Model', cell: ({ row }) => <span className="font-medium text-ink">{row.original.displayName}</span> },
        { accessorKey: 'id', header: 'Alias', cell: ({ getValue }) => <code className="rounded bg-paper-3 px-1.5 py-0.5 font-mono text-xs text-ink-2">{getValue()}</code> },
        { accessorKey: 'category', header: 'Category', cell: ({ getValue }) => <Badge tone={getValue() === 'video' ? 'violet' : 'blue'}>{getValue()}</Badge> },
        { accessorKey: 'kind', header: 'Pricing kind', cell: ({ getValue }) => <span className="text-ink-2">{getValue()}</span> },
        { accessorKey: 'isDefault', header: 'Org default', cell: ({ getValue }) => (getValue() ? <Badge tone="green">default</Badge> : <span className="text-ink-3">—</span>) },
        { accessorKey: 'month_spend', header: 'Spend (month)', cell: ({ getValue }) => <span className="font-mono tabular-nums">{fmtUsd(getValue())}</span> },
    ];

    return (
        <div>
            <PageHeader title="Models" subtitle="The catalog is data — adding a model is a row, not a deploy. Nano Banana routes activate when GOOGLE_API_KEY is configured." />
            {items.length
                ? <DataTable columns={columns} data={items} searchable={false} />
                : <EmptyState icon={Boxes} title="Catalog not loaded" hint="Join a project to see the effective catalog, or run the migration to seed it." />}
            <Card className="mt-4 text-xs leading-relaxed text-ink-3">
                Access precedence: <span className="text-ink-2">user DENY → user ALLOW → project grant → org default → deny</span>.
                Grants and overrides can carry an expiry; enforcement happens on every request server-side, and revokes cancel queued jobs instantly.
            </Card>
        </div>
    );
}
