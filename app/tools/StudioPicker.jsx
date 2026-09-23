'use client';

// Shared "pick a generated video" dialog for the tools pages (Compare,
// Upscale, EXR). Browses the caller's own generations by default (same source
// as the studio history rail) or any community gallery creator's work via the
// dropdown — the gallery is browsable by every signed-in user, so this reuses
// the same endpoints. onPick receives the raw gallery item (archiveUrl,
// prompt, duration, resolution, taskId, …).

import { useEffect, useState } from 'react';
import { Film, X } from 'lucide-react';

export default function StudioPicker({ onClose, onPick }) {
    const [creators, setCreators] = useState([]);
    const [creator, setCreator] = useState('mine');
    const [items, setItems] = useState(null);
    const [error, setError] = useState(null);
    const [query, setQuery] = useState('');

    useEffect(() => {
        let alive = true;
        fetch('/api/gallery')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (alive && d) setCreators((d.creators || []).filter((c) => c.generations > 0 && c.id !== d.me)); })
            .catch(() => { /* the dropdown just stays at My videos */ });
        return () => { alive = false; };
    }, []);

    useEffect(() => {
        let alive = true;
        setItems(null);
        setError(null);
        const url = creator === 'mine' ? '/api/gallery?mine=1' : `/api/gallery?user=${encodeURIComponent(creator)}`;
        fetch(url)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Could not load the videos (${r.status}).`))))
            .then((d) => {
                if (!alive) return;
                setItems((d.items || []).filter((it) => it.mediaType === 'video' && it.archiveUrl && it.status === 'succeeded'));
            })
            .catch((e) => { if (alive) setError(e.message); });
        return () => { alive = false; };
    }, [creator]);

    const shown = (items || []).filter((it) => !query || (it.prompt || '').toLowerCase().includes(query.toLowerCase()));

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <section role="dialog" aria-modal="true" className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl border border-line bg-paper-1 p-4 shadow-2xl">
                <div className="mb-3 flex items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold">Pick a generated video</h2>
                    <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink"><X size={16} /></button>
                </div>
                <div className="mb-3 flex gap-2">
                    <select value={creator} onChange={(e) => setCreator(e.target.value)} title="Whose gallery to browse"
                        className="rounded-md border border-line bg-paper-3 px-2 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent">
                        <option value="mine">My videos</option>
                        {creators.map((c) => <option key={c.id} value={c.id}>{c.name || c.email}</option>)}
                    </select>
                    <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search prompts…"
                        className="min-w-0 flex-1 rounded-md border border-line bg-paper-3 px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent" />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                    {error ? <p className="p-3 text-xs text-danger">{error}</p>
                        : items == null ? <p className="p-3 text-xs text-ink-3">Loading your videos…</p>
                            : !shown.length ? <p className="p-3 text-xs text-ink-3">{query ? 'No videos match that search.' : creator === 'mine' ? 'No finished videos in your studio yet.' : 'This creator has no finished videos.'}</p>
                                : (
                                    <ul className="divide-y divide-line/60">
                                        {shown.map((it) => (
                                            <li key={it.taskId}>
                                                <button type="button" onClick={() => onPick(it)}
                                                    className="flex w-full items-center gap-3 px-2 py-2.5 text-left transition-colors hover:bg-paper-2">
                                                    <Film size={14} className="shrink-0 text-ink-3" />
                                                    <span className="min-w-0 flex-1">
                                                        <span className="block truncate text-sm text-ink-2">{it.prompt || it.taskId}</span>
                                                        <span className="block text-[11px] text-ink-3">{it.modelName} · {it.resolution || ''} {it.duration ? `· ${it.duration}s` : ''} · {new Date(it.createdAt).toLocaleDateString()}</span>
                                                    </span>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                </div>
            </section>
        </div>
    );
}
