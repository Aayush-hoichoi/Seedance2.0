'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { ArchiveRestore, ArrowLeft, BriefcaseBusiness, Users } from 'lucide-react';
import { Badge, Button, DataTable, EmptyState, PageHeader, useColumns } from '../../ui.jsx';
import { fmtDate, fmtUsd, useApi, sendJson } from '../../lib.js';

export default function ArchivedProjectsClient() {
    const { data, error, mutate } = useApi('/api/admin/projects/archived');
    const [restoringId, setRestoringId] = useState(null);
    const restoringIdRef = useRef(null);
    restoringIdRef.current = restoringId;
    const isAdmin = data?.role === 'admin' || data?.isPlatformAdmin;

    async function restore(project) {
        if (restoringIdRef.current) return;
        setRestoringId(project.id);
        const result = await sendJson(`/api/admin/projects/${project.id}/restore`, 'POST', {});
        setRestoringId(null);
        if (!result.ok) return toast.error(result.data?.message || 'Could not restore the project');
        toast.success(`Project “${project.name}” restored`);
        mutate();
    }

    const columns = useColumns([
        {
            accessorKey: 'name',
            header: 'Project',
            cell: ({ getValue }) => <span className="font-medium text-ink">{getValue()}</span>,
        },
        {
            accessorKey: 'archived_at',
            header: 'Archived',
            cell: ({ getValue }) => <span className="tabular-nums">{fmtDate(getValue())}</span>,
        },
        {
            accessorKey: 'member_count',
            header: 'Members',
            cell: ({ getValue }) => <span className="inline-flex items-center gap-1.5 font-mono tabular-nums"><Users size={12} className="text-ink-3" />{getValue() ?? 0}</span>,
        },
        {
            accessorKey: 'job_count',
            header: 'Jobs',
            cell: ({ getValue }) => <span className="inline-flex items-center gap-1.5 font-mono tabular-nums"><BriefcaseBusiness size={12} className="text-ink-3" />{getValue() ?? 0}</span>,
        },
        {
            accessorKey: 'spent_usd',
            header: 'Total spend',
            cell: ({ getValue }) => <span className="font-mono tabular-nums text-ink">{fmtUsd(getValue())}</span>,
        },
        {
            id: 'restore',
            header: '',
            enableSorting: false,
            cell: ({ row }) => (
                <Button variant="outline" size="xs" loading={restoringIdRef.current === row.original.id}
                    disabled={!!restoringIdRef.current} onClick={() => restore(row.original)}>
                    <ArchiveRestore size={13} /> Restore
                </Button>
            ),
        },
    ]);

    return (
        <div>
            <PageHeader title="Archived projects" subtitle="Restore a project to make it available to its existing members again.">
                <Link href="/console/projects" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink">
                    <ArrowLeft size={13} /> All projects
                </Link>
            </PageHeader>
            {error ? (
                <EmptyState title={error.code === 'FORBIDDEN' ? 'Admin access required' : 'Couldn’t load archived projects'} hint={error.message} />
            ) : !data ? (
                <div className="rounded-[13px] border border-line px-4 py-10 text-center text-sm text-ink-3">Loading archived projects…</div>
            ) : !isAdmin ? (
                <EmptyState title="Admin access required" hint="Only platform admins can view or restore archived projects." />
            ) : (
                <>
                    {data.items?.length ? <div className="mb-3"><Badge tone="zinc">{data.items.length} archived</Badge></div> : null}
                    <DataTable columns={columns} data={data.items ?? []} searchable pageSize={15} empty="No archived projects." />
                </>
            )}
        </div>
    );
}
