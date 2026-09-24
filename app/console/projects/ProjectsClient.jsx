'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { PageHeader, Badge, Button, Modal, Field, Input, EmptyState, DataTable, useColumns } from '../ui.jsx';
import { useApi, sendJson } from '../lib.js';
import { Users, Plus, Trash2 } from 'lucide-react';

export default function ProjectsClient() {
    const { data, error, mutate } = useApi('/api/projects');
    const [open, setOpen] = useState(false);
    const [name, setName] = useState('');
    const [saving, setSaving] = useState(false);
    const isAdmin = data?.canManageProjects ?? (data?.role === 'admin');
    // Project-initiation requests are decided on the console Requests page.
    const canDecide = data?.role === 'admin';
    // Archive (soft-delete): hides the project and stops new generations; jobs,
    // spend and audit history keep their project_id (DELETE /api/projects/[id]).
    const [toArchive, setToArchive] = useState(null);
    const [archiving, setArchiving] = useState(false);
    // useColumns memoizes cells on first render — read live values via a ref.
    // Archive is platform-admin only (the server enforces it too) — managers
    // can create projects but not remove them.
    const isAdminRef = useRef(false);
    isAdminRef.current = canDecide;

    async function archive() {
        if (!toArchive) return;
        setArchiving(true);
        const r = await sendJson(`/api/projects/${toArchive.id}`, 'DELETE');
        setArchiving(false);
        if (!r.ok) return toast.error(r.data?.message || 'Could not archive the project');
        toast.success(`Project “${toArchive.name}” archived`);
        setToArchive(null);
        mutate();
    }


    async function create() {
        setSaving(true);
        const r = await sendJson('/api/projects', 'POST', { name });
        setSaving(false);
        if (!r.ok) return toast.error(r.data?.message || 'Could not create project');
        toast.success(`Project “${name}” created`);
        setOpen(false); setName('');
        mutate();
    }

    const items = data?.items ?? [];

    const columns = useColumns([
        {
            accessorKey: 'name',
            header: 'Project',
            cell: ({ row }) => (
                <Link href={`/console/projects/${row.original.id}`} className="font-medium text-ink hover:text-accent-hi">
                    {row.original.name}
                </Link>
            ),
        },
        {
            accessorKey: 'paused',
            header: 'Status',
            cell: ({ getValue }) => (getValue() ? <Badge tone="amber">paused</Badge> : <Badge tone="green">active</Badge>),
        },
        {
            accessorKey: 'member_count',
            header: 'Members',
            cell: ({ getValue }) => (
                <span className="inline-flex items-center gap-1.5 font-mono tabular-nums text-ink-2">
                    <Users size={12} className="text-ink-3" /> {getValue() ?? 0}
                </span>
            ),
        },
        {
            accessorKey: 'spent_usd',
            header: 'Spent',
            cell: ({ getValue }) => <span className="font-mono tabular-nums text-ink">${Number(getValue() ?? 0).toFixed(2)}</span>,
        },
        {
            id: 'manage',
            header: '',
            enableSorting: false,
            cell: ({ row }) => (
                <div className="inline-flex items-center gap-3">
                    <Link href={`/console/projects/${row.original.id}`} className="text-xs font-semibold text-ink-3 hover:text-ink">Manage</Link>
                    {isAdminRef.current && row.original.name !== 'Default' ? (
                        <button
                            type="button"
                            title="Archive this project (stops new generations; usage history is kept)"
                            onClick={() => setToArchive(row.original)}
                            className="text-ink-3 transition-colors hover:text-danger"
                        >
                            <Trash2 size={14} />
                        </button>
                    ) : null}
                </div>
            ),
        },
    ]);

    return (
        <div>
            <PageHeader title="Projects" subtitle="Model access, members and budgets are managed per project">
                {isAdmin ? <Button variant="primary" onClick={() => setOpen(true)}><Plus size={14} /> New project</Button> : null}
            </PageHeader>
            {error ? (
                <EmptyState title="Couldn’t load projects" hint={error.message} />
            ) : (
                <DataTable
                    columns={columns}
                    data={items}
                    searchable={items.length > 8}
                    pageSize={15}
                    empty="No projects yet — run scripts/migrate-gateway.mjs to create the Default project, or create one here."
                />
            )}
            <Modal open={!!toArchive} onOpenChange={(v) => { if (!v) setToArchive(null); }} title={`Archive “${toArchive?.name}”?`}
                footer={<>
                    <Button variant="outline" onClick={() => setToArchive(null)}>Cancel</Button>
                    <Button variant="danger" onClick={archive} loading={archiving}>Archive project</Button>
                </>}>
                <p className="text-sm text-ink-2">
                    The project is hidden and stops accepting new generations. Jobs, spend and audit history are kept, and creating a project with the same name later revives it.
                </p>
            </Modal>
            <Modal open={open} onOpenChange={setOpen} title="Create project"
                footer={<>
                    <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                    <Button variant="primary" onClick={create} loading={saving} disabled={!name.trim()}>Create</Button>
                </>}>
                <Field label="Project name">
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Marketing Videos" autoFocus />
                </Field>
            </Modal>
        </div>
    );
}
