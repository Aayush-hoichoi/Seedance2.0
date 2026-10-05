'use client';

// Shared "pick a generated video" dialog for the tools pages (Compare,
// Upscale, EXR). Browses the caller's own generations by default (same source
// as the studio history rail) or any community gallery creator's work via the
// dropdown — the gallery is browsable by every signed-in user, so this reuses
// the same endpoints. onPick receives the raw gallery item (archiveUrl,
// prompt, duration, resolution, taskId, …).

import { useEffect, useRef, useState } from 'react';
import { Film, X } from 'lucide-react';

// Small pages keep the picker usable on slow networks — each item carries
// prompts + presigned URLs, so the old single 200-row response was hundreds
// of KB and often failed to load before the dialog was dismissed.
const PAGE = 24;
const pickerUrl = (creator, before) => {
    const params = new URLSearchParams(creator === 'mine' ? { mine: '1' } : { user: creator });
    params.set('limit', String(PAGE));
    if (before) params.set('before', before);
    return `/api/gallery?${params.toString()}`;
};

export default function StudioPicker({ onClose, onPick }) {
    const [creators, setCreators] = useState([]);
    const [creator, setCreator] = useState('mine');
    const [items, setItems] = useState(null);
    const [nextBefore, setNextBefore] = useState(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState(null);
    const [query, setQuery] = useState('');
    const creatorRef = useRef(creator);
    creatorRef.current = creator;
    const listRef = useRef(null);
    const sentinelRef = useRef(null);

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
        setNextBefore(null);
        setError(null);
        fetch(pickerUrl(creator))
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Could not load the videos (${r.status}).`))))
            .then((d) => {
                if (!alive) return;
                setItems((d.items || []).filter((it) => it.mediaType === 'video' && it.archiveUrl && it.status === 'succeeded'));
                setNextBefore(d.nextBefore || null);
            })
            .catch((e) => { if (alive) setError(e.message); });
        return () => { alive = false; };
    }, [creator]);

    const loadMore = async () => {
        if (!nextBefore || loadingMore) return;
        const forCreator = creator; // drop the response if the dropdown changed meanwhile
        setLoadingMore(true);
        setError(null);
        try {
            const r = await fetch(pickerUrl(creator, nextBefore));
            if (!r.ok) throw new Error(`Could not load older videos (${r.status}).`);
            const d = await r.json();
            if (forCreator !== creatorRef.current) return;
            setItems((prev) => [...(prev || []), ...(d.items || []).filter((it) => it.mediaType === 'video' && it.archiveUrl && it.status === 'succeeded')]);
            setNextBefore(d.nextBefore || null);
        } catch (e) {
            if (forCreator === creatorRef.current) setError(e.message);
        } finally {
            if (forCreator === creatorRef.current) setLoadingMore(false);
        }
    };

    // Infinite scroll: when the sentinel at the list's bottom nears view,
    // fetch the next page. Re-observed after every page so it keeps firing
    // while the sentinel stays visible (the observer only reports changes).
    const loadMoreRef = useRef(loadMore);
    loadMoreRef.current = loadMore;
    useEffect(() => {
        const el = sentinelRef.current;
        if (!el || typeof IntersectionObserver === 'undefined') return;
        const obs = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) loadMoreRef.current(); },
            { root: listRef.current, rootMargin: '200px' });
        obs.observe(el);
        return () => obs.disconnect();
    }, [items, nextBefore]);

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
                <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
                    {error ? <p className="p-3 text-xs text-danger">{error}</p>
                        : items == null ? <p className="p-3 text-xs text-ink-3">Loading your videos…</p>
                            : !shown.length ? <p className="p-3 text-xs text-ink-3">{nextBefore ? 'Loading older videos…' : query ? 'No videos match that search.' : creator === 'mine' ? 'No finished videos in your studio yet.' : 'This creator has no finished videos.'}</p>
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
                    {!error && items != null && nextBefore && (
                        <div ref={sentinelRef} className="flex justify-center py-2 text-xs text-ink-3">
                            {loadingMore ? 'Loading…' : ''}
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}
