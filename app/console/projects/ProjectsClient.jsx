'use client';

import { useState } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { PageHeader, Card, Badge, Button, Modal, Field, Input, EmptyState } from '../ui.jsx';
import { useApi, sendJson } from '../lib.js';
import { FolderKanban, Users, PauseCircle, Plus } from 'lucide-react';

export default function ProjectsClient() {
    const { data, error, mutate } = useApi('/api/projects');
    const [open, setOpen] = useState(false);
    const [name, setName] = useState('');
    const [saving, setSaving] = useState(false);
    const isAdmin = data?.role === 'admin';

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
    return (
        <div>
            <PageHeader title="Projects" subtitle="Model access, members and budgets are managed per project">
                {isAdmin ? <Button variant="primary" onClick={() => setOpen(true)}><Plus size={14} /> New project</Button> : null}
            </PageHeader>
            {error ? <EmptyState title="Couldn’t load projects" hint={error.message} /> : null}
            {!error && !items.length ? (
                <EmptyState icon={FolderKanban} title="No projects yet"
                    hint="Run scripts/migrate-gateway.mjs to create the Default project, or create one here." />
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((p) => (
                    <Link key={p.id} href={`/console/projects/${p.id}`}>
                        <Card className="h-full transition-colors hover:border-zinc-600">
                            <div className="flex items-start justify-between">
                                <div className="text-sm font-semibold text-zinc-100">{p.name}</div>
                                {p.paused ? <Badge tone="amber"><PauseCircle size={11} /> paused</Badge> : <Badge tone="green">active</Badge>}
                            </div>
                            <div className="mt-3 flex items-center gap-3 text-xs text-zinc-500">
                                <span className="inline-flex items-center gap-1"><Users size={12} /> {p.member_count} member{p.member_count === 1 ? '' : 's'}</span>
                                {p.my_role ? <Badge tone="blue">{p.my_role}</Badge> : null}
                            </div>
                        </Card>
                    </Link>
                ))}
            </div>
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
