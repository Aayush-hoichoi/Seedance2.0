'use client';

// Characters — the project's shared cast, in one tab.
//
// Every member of a project sees the same characters: a card per character
// with its reference image, name, description and creator. Create one by
// uploading a photo, or build one in the embedded Try-On studio below
// (generate → dress → "Lock to project cast"). Once saved, a character is
// taggable in the studio prompt with "@Name" — the tag attaches the stored
// reference image automatically and the description is injected server-side
// as a CHARACTER LOCK, so the whole team generates the same person without
// ever re-uploading a photo. That's the continuity story: one approved face
// + one approved description, shared, versioned by edits, used everywhere.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, Pencil, Plus, Trash2, Upload, Users, X } from 'lucide-react';
import ProjectSelect from '../seedance/ProjectSelect.jsx';
import ToolAccessGate, { useToolStatus } from '../tools/ToolAccessGate.jsx';
import { TryOnWorkspace, storeFetch, fileSrc } from '../tools/tryon/TryOnClient.jsx';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import { uploadToCdn } from '../../lib/seedance/upload.js';
import { resolveProjectId, rememberProjectId } from '../../lib/seedance/projectChoice.mjs';

const DESCRIPTION_MAX = 1500;

export default function CharactersClient() {
    const [projects, setProjects] = useState([]);
    const [projectId, setProjectId] = useState(null);
    const [projectsError, setProjectsError] = useState(null);
    // Model access + workflows feed the embedded Try-On studio, same as the
    // old /tools/tryon page did.
    const [modelAccess, setModelAccess] = useState(null);
    const [workflows, setWorkflows] = useState([]);
    const [wfAccess, setWfAccess] = useState('none');
    const { status, error: statusError, refresh } = useToolStatus('tryon', projectId);
    // Bumped whenever the embedded studio locks/removes a cast member, so the
    // grid above refetches without a reload.
    const [castVersion, setCastVersion] = useState(0);

    useEffect(() => {
        fetch('/api/projects')
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Could not load projects (${r.status}).`))))
            .then((d) => {
                const items = Array.isArray(d?.items) ? d.items : [];
                setProjects(items);
                setProjectId(resolveProjectId(items, window.location.search, window.localStorage));
            })
            .catch((e) => setProjectsError(e.message));
    }, []);

    useEffect(() => {
        let alive = true;
        fetch('/api/workflows')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                if (!alive || !d) return;
                setWorkflows(Array.isArray(d.items) ? d.items : []);
                setWfAccess(d.access ?? 'none');
            })
            .catch(() => { /* picker just stays hidden */ });
        return () => { alive = false; };
    }, []);

    useEffect(() => {
        if (!projectId) return undefined;
        let alive = true;
        setModelAccess(null);
        fetch(`/api/models?projectId=${projectId}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                if (!alive || !Array.isArray(d?.items)) return;
                const allowed = d.items.filter((i) => i.allowed);
                setModelAccess({
                    ids: new Set(allowed.map((i) => i.id)),
                    kinds: new Set(allowed.map((i) => i.kind).filter(Boolean)),
                });
            })
            .catch(() => { /* unknown access — leave everything selectable */ });
        return () => { alive = false; };
    }, [projectId]);

    const pickProject = (id) => { setProjectId(id); rememberProjectId(id, window.localStorage); };

    return (
        <div className="min-h-screen w-full bg-app-bg px-4 py-6 text-ink sm:px-8">
            <div className="mx-auto max-w-7xl">
                <header className="mb-6 flex flex-wrap items-center gap-3">
                    <Link href="/seedance" title="Back to the studio" className="grid h-7 w-7 place-items-center rounded-md border border-line bg-paper-2 text-ink-3 transition-colors hover:text-ink">
                        <ArrowLeft size={14} />
                    </Link>
                    <h1 className="inline-flex items-center gap-2 font-display text-xl font-semibold"><Users size={18} /> Characters</h1>
                    <span className="rounded-full border border-line px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">shared project cast</span>
                    <div className="ml-auto flex items-center gap-2">
                        {projects.length > 0 && <ProjectSelect projects={projects} value={projectId} onChange={pickProject} />}
                    </div>
                </header>
                {projectsError
                    ? <div className="text-xs text-danger">{projectsError}</div>
                    : (
                        <div className="flex flex-col gap-8">
                            <CharacterGrid projectId={projectId} castVersion={castVersion} />
                            <section className="flex flex-col gap-3">
                                <div>
                                    <h2 className="text-sm font-semibold">Try-On studio</h2>
                                    <p className="text-xs text-ink-3">Create a character from a prompt or an actor photo, dress them with costumes and props, then “Lock to project cast” to save them above.</p>
                                </div>
                                <ToolAccessGate toolName="Try-On" status={status} error={statusError} projectId={projectId} onChanged={refresh} needsToolBudget={false}>
                                    <TryOnWorkspace
                                        projectId={projectId}
                                        modelAccess={modelAccess}
                                        workflows={workflows}
                                        wfAccess={wfAccess}
                                        onCastChange={() => setCastVersion((v) => v + 1)}
                                    />
                                </ToolAccessGate>
                            </section>
                        </div>
                    )}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// The cast grid — every character card shows image, name, description and who
// created it; any member edits name/description, the creator or an admin
// replaces the image or deletes.

function CharacterGrid({ projectId, castVersion }) {
    const [items, setItems] = useState([]);
    const [error, setError] = useState(null);
    const [editing, setEditing] = useState(null); // null | 'new' | a character row
    const [pendingDelete, setPendingDelete] = useState(null); // a character row
    const [busy, setBusy] = useState(false);

    const load = useCallback(() => {
        if (!projectId) { setItems([]); return undefined; }
        let alive = true;
        storeFetch(`/api/tryon/characters?projectId=${projectId}`)
            .then((d) => { if (alive) { setItems(d.items || []); setError(null); } })
            .catch((e) => { if (alive) setError(e.message); });
        return () => { alive = false; };
    }, [projectId]);

    useEffect(() => load(), [load, castVersion]);

    const save = async ({ id, name, description, file }) => {
        setBusy(true);
        setError(null);
        try {
            let mediaKey;
            if (file) ({ key: mediaKey } = await uploadToCdn(file));
            if (id) {
                const d = await storeFetch('/api/tryon/characters', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ projectId, id, name, description, ...(mediaKey ? { mediaKey, kind: 'image' } : {}) }),
                });
                setItems((prev) => prev.map((c) => (c.id === id ? { ...c, ...d.item } : c)));
            } else {
                if (!mediaKey) throw new Error('A reference image is required.');
                const d = await storeFetch('/api/tryon/characters', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ projectId, name, description, mediaKey, kind: 'image' }),
                });
                setItems((prev) => [d.item, ...prev]);
            }
            setEditing(null);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!pendingDelete) return;
        setBusy(true);
        try {
            await storeFetch(`/api/tryon/characters?id=${pendingDelete.id}&projectId=${projectId}`, { method: 'DELETE' });
            setItems((prev) => prev.filter((c) => c.id !== pendingDelete.id));
            setPendingDelete(null);
            setError(null);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    if (!projectId) return <p className="text-xs text-ink-3">Pick a project to see its characters.</p>;

    return (
        <section className="flex flex-col gap-3">
            <ConfirmDialog
                open={!!pendingDelete}
                onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
                title={`Remove ${pendingDelete?.name || 'this character'}?`}
                description="The character disappears from the cast, the “@” prompt menu and the vault for every project member. Generations already made with it are untouched."
                confirmLabel="Remove"
                onConfirm={remove}
                loading={busy}
            />
            <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-ink-3">
                    {items.length
                        ? `${items.length} character${items.length === 1 ? '' : 's'} — tag one in the studio prompt with “@Name” to use it as the reference, no upload needed.`
                        : 'No characters yet — add one with a photo, or build one in the Try-On studio below and lock it to the cast.'}
                </p>
                <button type="button" onClick={() => setEditing('new')}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-[11px] font-semibold text-accent-hi transition-colors hover:bg-accent/20">
                    <Plus size={13} /> New character
                </button>
            </div>
            {error && <div className="rounded-md border border-danger/20 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">{error}</div>}
            {items.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {items.map((c) => (
                        <article key={c.id} className="flex gap-3 rounded-xl border border-line bg-paper-2 p-3">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={fileSrc(c.media_key)} alt={c.name} className="h-24 w-24 shrink-0 rounded-lg border border-line object-cover" />
                            <div className="flex min-w-0 flex-1 flex-col">
                                <div className="flex items-start justify-between gap-2">
                                    <h3 className="truncate text-sm font-semibold" title={c.name}>{c.name}</h3>
                                    <div className="flex shrink-0 gap-1">
                                        <button type="button" title="Edit name, description or image" onClick={() => setEditing(c)}
                                            className="grid h-6 w-6 place-items-center rounded-md border border-line bg-paper-3 text-ink-3 transition-colors hover:text-ink">
                                            <Pencil size={11} />
                                        </button>
                                        <button type="button" title="Remove from the cast (creator or admin)" onClick={() => setPendingDelete(c)}
                                            className="grid h-6 w-6 place-items-center rounded-md border border-line bg-paper-3 text-ink-3 transition-colors hover:text-danger">
                                            <Trash2 size={11} />
                                        </button>
                                    </div>
                                </div>
                                <p className="mt-0.5 line-clamp-3 flex-1 text-[11px] leading-relaxed text-ink-2" title={c.description || ''}>
                                    {c.description || <span className="italic text-ink-3">No description yet — add one so prompts naming {c.name} lock the identity.</span>}
                                </p>
                                <p className="mt-1 text-[10px] text-ink-3">
                                    by {c.creator_name || 'a teammate'} · {c.created_at ? new Date(c.created_at).toLocaleDateString() : ''}
                                </p>
                            </div>
                        </article>
                    ))}
                </div>
            )}
            {editing && (
                <CharacterForm
                    character={editing === 'new' ? null : editing}
                    busy={busy}
                    onSave={save}
                    onClose={() => setEditing(null)}
                />
            )}
        </section>
    );
}

// Create/edit modal. New characters need a photo; edits may replace it (the
// server lets only the creator or an admin swap the locked identity image).
function CharacterForm({ character, busy, onSave, onClose }) {
    const [name, setName] = useState(character?.name || '');
    const [description, setDescription] = useState(character?.description || '');
    const [file, setFile] = useState(null);
    const [preview, setPreview] = useState(null);

    const pickFile = (f) => {
        if (!f || !f.type?.startsWith('image/')) return;
        setFile(f);
        setPreview((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(f); });
    };
    useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

    const canSave = name.trim() && (character || file) && !busy;

    return (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-black/60 p-4" onClick={onClose}>
            <div className="w-full max-w-md rounded-xl border border-line bg-paper-1 p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">{character ? `Edit ${character.name}` : 'New character'}</h3>
                    <button type="button" onClick={onClose} aria-label="Close" className="text-ink-3 transition-colors hover:text-ink"><X size={14} /></button>
                </div>
                <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-3">
                        {(preview || character) && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={preview || fileSrc(character.media_key)} alt={name || 'character'} className="h-20 w-20 rounded-lg border border-line object-cover" />
                        )}
                        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-paper-3 px-2.5 py-1.5 text-[11px] font-semibold text-ink-2 transition-colors hover:text-ink">
                            <Upload size={12} /> {character ? 'Replace image' : 'Reference photo'}
                            <input type="file" accept="image/*" className="hidden" onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />
                        </label>
                    </div>
                    <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name — what the team types after “@”" maxLength={120}
                        className="w-full rounded-md border border-line bg-paper-3 px-3 py-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent" />
                    <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} maxLength={DESCRIPTION_MAX}
                        placeholder="Description — face, hair, wardrobe, build, age… injected into every prompt that names this character, so write it like a casting sheet."
                        className="w-full resize-none rounded-md border border-line bg-paper-3 px-3 py-2 text-xs leading-relaxed text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent" />
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] text-ink-3">{description.length}/{DESCRIPTION_MAX}</span>
                        <button type="button" disabled={!canSave}
                            onClick={() => onSave({ id: character?.id, name: name.trim(), description: description.trim(), file })}
                            className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-[11px] font-semibold text-accent-hi transition-colors hover:bg-accent/20 disabled:opacity-40">
                            {busy && <Loader2 size={12} className="animate-spin" />} {character ? 'Save changes' : 'Save character'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
