'use client';

// Console Workflows page: every workflow in the workspace — the official
// project-style ones and every user's customs (private included) — with the
// full style detail the studio picker hides. Customs also get visibility
// controls here (an admin publishing IS the approval, so a pending one goes
// public directly); access requests stay in the Requests hub.

import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Workflow as WorkflowIcon } from 'lucide-react';
import { PageHeader, DataTable, Badge, Modal, EmptyState, Button, Segmented } from '../ui.jsx';
import { useApi, sendJson, fmtDate } from '../lib.js';

const MEDIA_TONE = { all: 'zinc', video: 'blue', image: 'violet' };
const VISIBILITY_TONE = { public: 'green', pending: 'amber', private: 'zinc' };

export default function WorkflowsClient() {
    const [tab, setTab] = useState('official');
    const [selected, setSelected] = useState(null);
    const { data, isLoading, mutate } = useApi('/api/admin/workflows');
    const items = data?.items ?? [];
    const official = items.filter((w) => w.official);
    const custom = items.filter((w) => !w.official);
    const rows = tab === 'official' ? official : custom;

    // Admin-side visibility moves ride the same endpoint owners use:
    // request_publish from an admin is both sides at once (→ public),
    // unpublish takes it private and detaches everyone but the owner.
    async function setVisibility(workflowId, action) {
        const r = await sendJson('/api/workflows/custom', 'PATCH', { workflowId, action });
        if (!r.ok) return toast.error(r.data?.error || 'Could not change visibility.');
        toast.success(r.data.visibility === 'public' ? 'Workflow is now public to the workspace.' : 'Workflow is private again.');
        mutate();
    }

    const columns = useMemo(() => [
        {
            accessorKey: 'name',
            header: 'Name',
            cell: ({ row }) => (
                <button type="button" onClick={() => setSelected(row.original)}
                    className="font-medium text-ink underline-offset-2 hover:underline">
                    {row.original.name}
                </button>
            ),
        },
        {
            accessorKey: 'description',
            header: 'Description',
            cell: ({ getValue }) => (
                <span className="block max-w-72 truncate text-ink-3" title={getValue() || ''}>{getValue() || '—'}</span>
            ),
        },
        {
            accessorKey: 'media',
            header: 'Media',
            cell: ({ getValue }) => <Badge tone={MEDIA_TONE[getValue()] || 'zinc'}>{getValue()}</Badge>,
        },
        ...(tab === 'custom' ? [
            {
                accessorKey: 'creator',
                header: 'Creator',
                cell: ({ getValue }) => <span className="text-ink-3">{getValue() || '—'}</span>,
            },
            {
                accessorKey: 'visibility',
                header: 'Visibility',
                cell: ({ row }) => {
                    const { id, visibility } = row.original;
                    return (
                        <div className="flex items-center gap-1.5">
                            <Badge tone={VISIBILITY_TONE[visibility] || 'zinc'}>{visibility}</Badge>
                            {visibility === 'private' && (
                                <Button size="xs" variant="outline" onClick={() => setVisibility(id, 'request_publish')}>Publish</Button>
                            )}
                            {visibility === 'pending' && (
                                <>
                                    <Button size="xs" variant="outline" onClick={() => setVisibility(id, 'request_publish')}>Approve</Button>
                                    <Button size="xs" variant="ghost" onClick={() => setVisibility(id, 'unpublish')}>Reject</Button>
                                </>
                            )}
                            {visibility === 'public' && (
                                <Button size="xs" variant="ghost" onClick={() => setVisibility(id, 'unpublish')}>Unpublish</Button>
                            )}
                        </div>
                    );
                },
            },
        ] : []),
        { accessorKey: 'looks', header: 'Looks', cell: ({ getValue }) => getValue().length },
        { accessorKey: 'version', header: 'Version', cell: ({ getValue }) => (getValue() == null ? '—' : `v${getValue()}`) },
        { accessorKey: 'attachedCount', header: 'Attached', cell: ({ getValue }) => getValue() || 0 },
        { accessorKey: 'createdAt', header: 'Created', cell: ({ getValue }) => fmtDate(getValue()) },
    ], [tab]);

    const TABS = [
        { id: 'official', label: 'Project Style', count: official.length },
        { id: 'custom', label: 'Custom', count: custom.length },
    ];

    return (
        <div>
            <PageHeader title="Workflows" subtitle="Every reusable style in the workspace — official project styles and user-created customs." />
            <Segmented className="mb-5" value={tab} onChange={setTab}
                options={TABS.map((t) => ({
                    id: t.id, label: t.label,
                    badge: <span className="grid min-w-5 place-items-center rounded-full bg-white/[0.07] px-1 text-[10px] font-semibold text-ink-3">{t.count}</span>,
                }))} />
            {!isLoading && !rows.length ? (
                <EmptyState icon={WorkflowIcon} title={tab === 'official' ? 'No project style workflows yet.' : 'No custom workflows yet.'}
                    hint={tab === 'official' ? 'Official workflows are seeded by the platform.' : 'Users create customs from the studio picker.'} />
            ) : (
                <DataTable columns={columns} data={rows} empty={isLoading ? 'Loading…' : 'Nothing here yet.'} />
            )}
            <WorkflowDetailModal workflow={selected} onClose={() => setSelected(null)} />
        </div>
    );
}

function DetailRow({ label, children }) {
    return (
        <div className="flex items-start justify-between gap-3 text-sm">
            <span className="shrink-0 text-xs font-medium uppercase tracking-[0.1em] text-ink-3">{label}</span>
            <span className="text-right text-ink-2">{children}</span>
        </div>
    );
}

function WorkflowDetailModal({ workflow, onClose }) {
    if (!workflow) return null;
    const w = workflow;
    return (
        <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title={w.name} className="sm:max-w-[560px]">
            <div className="space-y-2 rounded border border-line bg-paper-2 p-3">
                <DetailRow label="Type">{w.official ? 'Project Style (official)' : 'Custom'}</DetailRow>
                <DetailRow label="Media"><Badge tone={MEDIA_TONE[w.media] || 'zinc'}>{w.media}</Badge></DetailRow>
                <DetailRow label="Visibility"><Badge tone={VISIBILITY_TONE[w.visibility] || 'zinc'}>{w.visibility}</Badge></DetailRow>
                {!w.official && <DetailRow label="Creator">{w.creator || '—'}</DetailRow>}
                <DetailRow label="Version">{w.version == null ? '—' : `v${w.version}`}</DetailRow>
                <DetailRow label="Attached users">{w.attachedCount || 0}</DetailRow>
                <DetailRow label="Created">{fmtDate(w.createdAt)}</DetailRow>
                <DetailRow label="Enabled">{w.enabled ? 'Yes' : 'No'}</DetailRow>
            </div>
            {(w.sourceDescription || w.description) ? (
                <div>
                    <div className="mb-1 text-xs font-medium uppercase tracking-[0.1em] text-ink-3">Description</div>
                    <p className="whitespace-pre-wrap text-sm text-ink-2">{w.sourceDescription || w.description}</p>
                </div>
            ) : null}
            <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-[0.1em] text-ink-3">
                    Looks ({w.looks.length}){w.defaultLook ? ` — default: ${w.defaultLook}` : ''}
                </div>
                <div className="space-y-2">
                    {w.looks.map((look) => (
                        <div key={look.key} className="rounded border border-line bg-paper-2 p-3">
                            <div className="mb-1 flex items-center gap-2">
                                <span className="text-sm font-medium text-ink">{look.name}</span>
                                {look.key === w.defaultLook && <Badge tone="blue">default</Badge>}
                            </div>
                            {look.match.length ? (
                                <div className="mb-1 text-xs text-ink-3">Matches: {look.match.join(', ')}</div>
                            ) : null}
                            <p className="whitespace-pre-wrap text-xs text-ink-2">{look.brief || '—'}</p>
                            {look.negatives ? (
                                <p className="mt-1.5 whitespace-pre-wrap text-xs text-danger/80">Avoid: {look.negatives}</p>
                            ) : null}
                        </div>
                    ))}
                </div>
            </div>
        </Modal>
    );
}
