'use client';

// Community Gallery — every creator on the platform and everything they've
// generated. Anyone can watch and REUSE any generation (prompt + refs +
// settings land back in the studio prompt bar); only the creator can delete,
// and that lives in the studio, not here.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { UserButton } from '@clerk/nextjs';
import { VideoCard, ImageCard, Lightbox, reuseInStudio, gradientFor, initialOf, timeAgo } from './shared.jsx';
import { useExrAccess } from '../components/ExrAccess.jsx';

export default function GalleryClient() {
    const router = useRouter();
    const [creators, setCreators] = useState(null); // null = loading
    const [me, setMe] = useState(null);
    const [selected, setSelected] = useState(null); // creator id
    const [items, setItems] = useState(null); // null = loading
    const [projects, setProjects] = useState(null); // project facets for selected creator
    const [projectId, setProjectId] = useState(''); // empty = all projects
    const [total, setTotal] = useState(0);
    const [nextBefore, setNextBefore] = useState(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [lightbox, setLightbox] = useState(null); // item
    const [error, setError] = useState(null);
    const [creatorsError, setCreatorsError] = useState(null);
    const [itemsError, setItemsError] = useState(null);
    const [moreError, setMoreError] = useState(null);
    const [creatorsAttempt, setCreatorsAttempt] = useState(0);
    const [itemsAttempt, setItemsAttempt] = useState(0);
    const [query, setQuery] = useState('');
    const requestEpochRef = useRef(0);
    const moreRequestRef = useRef(null);
    const { access: exrAccess, requesting: exrAccessRequesting, request: requestExrAccess } = useExrAccess();

    const askForExrAccess = async () => {
        const result = await requestExrAccess();
        if (!result.ok) setError(result.data?.error || 'Could not request EXR access.');
    };

    useEffect(() => {
        let alive = true;
        const controller = new AbortController();
        setCreatorsError(null);
        fetchGallery('/api/gallery', controller.signal, 'Could not load the gallery.')
            .then((d) => {
                if (!alive) return;
                setCreators(d.creators || []);
                setMe(d.me || null);
                // The API hands these back newest-active first, so the first
                // creator with work is the most recently active one — land
                // there so the page opens onto real work, not an empty pane.
                const first = (d.creators || []).find((c) => c.generations > 0) || (d.creators || [])[0];
                if (first) setSelected(first.id);
            })
            .catch((e) => { if (alive) setCreatorsError(e.message); });
        return () => { alive = false; controller.abort(); };
    }, [creatorsAttempt]);

    useEffect(() => {
        if (!selected) return;
        let alive = true;
        // A creator/project can be selected again before an old page finishes.
        // An epoch distinguishes those visits even when their URLs are equal.
        const epoch = ++requestEpochRef.current;
        const controller = new AbortController();
        setItems(null);
        setError(null);
        setItemsError(null);
        setMoreError(null);
        setNextBefore(null);
        setLoadingMore(false);
        setLightbox(null);
        fetchGallery(galleryUrl(selected, projectId), controller.signal, 'Could not load this creator’s work.')
            .then((d) => {
                if (!alive || requestEpochRef.current !== epoch) return;
                setItems(d.items || []);
                setProjects(d.projects || []);
                setTotal(Number(d.total) || 0);
                setNextBefore(d.nextBefore ? { before: d.nextBefore, beforeId: d.nextBeforeId || null } : null);
            })
            .catch((e) => { if (alive) { setItemsError(e.message); setItems([]); } });
        return () => {
            alive = false;
            requestEpochRef.current += 1;
            controller.abort();
            moreRequestRef.current?.abort();
            moreRequestRef.current = null;
        };
    }, [selected, projectId, itemsAttempt]);

    const creator = useMemo(() => creators?.find((c) => c.id === selected) || null, [creators, selected]);

    // Same list, same order — just narrowed. Name or email, whichever the
    // person searching happens to know.
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q || !creators) return creators;
        return creators.filter((c) => `${c.name || ''} ${c.email || ''}`.toLowerCase().includes(q));
    }, [creators, query]);

    const activeProject = useMemo(
        () => projects?.find((project) => String(project.id) === projectId) || null,
        [projects, projectId],
    );
    const mediaTotals = useMemo(() => {
        if (activeProject) return activeProject;
        return (projects || []).reduce((sum, project) => ({
            images: sum.images + project.images,
            videos: sum.videos + project.videos,
        }), { images: 0, videos: 0 });
    }, [projects, activeProject]);

    const chooseCreator = (id) => {
        if (id === selected) {
            if (projectId) setProjectId('');
            return;
        }
        setSelected(id);
        setProjectId('');
        setProjects(null);
    };

    const markExrReady = (taskId, exrUrl, exrArchiveKey = null) => {
        setItems((current) => current?.map((item) => item.taskId === taskId ? { ...item, exrUrl, exrArchiveKey } : item));
        setLightbox((current) => current?.taskId === taskId ? { ...current, exrUrl, exrArchiveKey } : current);
    };

    const loadMore = async () => {
        if (!selected || !nextBefore || moreRequestRef.current) return;
        const epoch = requestEpochRef.current;
        const controller = new AbortController();
        moreRequestRef.current = controller;
        setLoadingMore(true);
        setMoreError(null);
        try {
            const data = await fetchGallery(galleryUrl(selected, projectId, nextBefore), controller.signal, 'Could not load older generations.');
            if (requestEpochRef.current !== epoch || controller.signal.aborted) return;
            setItems((current) => {
                const known = new Set((current || []).map((item) => item.taskId));
                return [...(current || []), ...(data.items || []).filter((item) => !known.has(item.taskId))];
            });
            setNextBefore(data.nextBefore ? { before: data.nextBefore, beforeId: data.nextBeforeId || null } : null);
        } catch (e) {
            if (requestEpochRef.current === epoch && !controller.signal.aborted) setMoreError(e.message);
        } finally {
            if (moreRequestRef.current === controller) moreRequestRef.current = null;
            if (requestEpochRef.current === epoch) setLoadingMore(false);
        }
    };

    return (
        <div className="relative min-h-screen w-full bg-app-bg text-white">
            {/* Top bar */}
            <header className="fixed top-0 inset-x-0 z-30 flex items-center justify-between px-4 sm:px-6 py-3.5 bg-app-bg/80 backdrop-blur-md border-b border-white/[0.06]">
                <div className="flex items-center gap-3 min-w-0">
                    <Link
                        href="/projects"
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-white/10 bg-white/[0.04] text-white/70 hover:text-white hover:border-white/25 hover:bg-white/[0.08] transition-colors text-xs font-semibold shrink-0"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
                        Projects
                    </Link>
                    <div className="min-w-0">
                        <h1 className="text-sm font-extrabold tracking-tight truncate">Community Gallery</h1>
                        <p className="text-[10px] text-white/35 truncate">Watch anyone’s work · reuse any setup</p>
                    </div>
                </div>
                <div className="flex items-center gap-2.5">
                    <Link
                        href="/liked"
                        title="Only the liked generations"
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-white/10 bg-white/[0.04] text-white/70 hover:text-rose-300 hover:border-rose-400/40 hover:bg-white/[0.08] transition-colors text-xs font-semibold"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" /></svg>
                        Liked
                    </Link>
                    <UserButton />
                </div>
            </header>

            <div className="pt-[4.2rem] flex min-h-screen">
                {/* Creators sidebar (desktop) / top strip (mobile) */}
                <aside className="hidden md:flex w-72 shrink-0 flex-col border-r border-white/[0.06] px-3 py-4 gap-1 overflow-y-auto custom-scrollbar sticky top-[4.2rem] h-[calc(100vh-4.2rem)]">
                    <p className="px-2 pb-2 text-[10px] font-bold uppercase tracking-wider text-white/30">
                        Creators{shown ? ` · ${shown.length}` : ''}
                    </p>
                    <input
                        type="search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search creators…"
                        aria-label="Search creators by name or email"
                        className="mb-2 w-full px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/[0.03] text-xs text-white placeholder:text-white/25 outline-none focus:border-primary/50 focus:bg-white/[0.05] transition-colors"
                    />
                    {creators === null && !creatorsError && [...Array(5)].map((_, i) => (
                        <div key={i} className="h-14 rounded-xl bg-white/[0.03] animate-pulse" />
                    ))}
                    {shown?.map((c) => (
                        <CreatorCard key={c.id} c={c} me={me} selected={c.id === selected} onClick={() => chooseCreator(c.id)} />
                    ))}
                    {shown?.length === 0 && query.trim() && (
                        <p className="px-2 text-xs text-white/35">No creator matches that.</p>
                    )}
                </aside>

                {/* Main pane */}
                <main className="flex-1 min-w-0 px-4 sm:px-6 py-4">
                    {/* Mobile creator search + strip */}
                    <input
                        type="search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search creators…"
                        aria-label="Search creators by name or email"
                        className="md:hidden mb-2 w-full px-2.5 py-2 rounded-lg border border-white/10 bg-white/[0.03] text-xs text-white placeholder:text-white/25 outline-none focus:border-primary/50"
                    />
                    <div className="md:hidden flex gap-2 overflow-x-auto pb-3 -mx-4 px-4">
                        {shown?.map((c) => (
                            <button
                                key={c.id}
                                type="button"
                                onClick={() => chooseCreator(c.id)}
                                className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-semibold whitespace-nowrap transition-colors ${c.id === selected ? 'border-primary/60 bg-primary/10 text-white' : 'border-white/10 bg-white/[0.03] text-white/60'}`}
                            >
                                <span className={`w-5 h-5 rounded-full bg-gradient-to-br ${gradientFor(c.id)} flex items-center justify-center text-[10px] font-black text-black/80`}>{initialOf(c)}</span>
                                {c.name || c.email}
                                <span className="text-white/35">{c.generations}</span>
                            </button>
                        ))}
                    </div>

                    {creators === null && !creatorsError && <GalleryLoading>Loading creators…</GalleryLoading>}
                    {creatorsError && <GalleryLoadError message={creatorsError} onRetry={() => setCreatorsAttempt((attempt) => attempt + 1)} />}
                    {creators?.length === 0 && !creatorsError && <p className="py-12 text-center text-sm text-white/45">No creators yet.</p>}

                    {creator && (
                        <div className="flex items-center gap-3 pb-4">
                            <div className={`w-10 h-10 rounded-full bg-gradient-to-br ${gradientFor(creator.id)} flex items-center justify-center text-base font-black text-black/80 shrink-0`}>{initialOf(creator)}</div>
                            <div className="min-w-0">
                                <h2 className="text-lg font-extrabold tracking-tight truncate">
                                    {creator.name || creator.email}
                                    {creator.id === me && <span className="ml-2 align-middle text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/15 text-primary">you</span>}
                                    {creator.role === 'admin' && <span className="ml-2 align-middle text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-300">admin</span>}
                                </h2>
                                <p className="text-[11px] text-white/35 truncate">
                                    {creator.email}{creator.last_at ? ` · last active ${timeAgo(creator.last_at)}` : ''}
                                </p>
                            </div>
                            <span className="ml-auto text-xs text-white/40 shrink-0">{creator.generations} generation{creator.generations === 1 ? '' : 's'}</span>
                        </div>
                    )}

                    {creator && projects !== null && projects.length > 0 && (
                        <div className="mb-4 flex flex-wrap items-center gap-2.5 rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2.5">
                            <label htmlFor="gallery-project" className="text-[10px] font-bold uppercase tracking-wider text-white/35">Project</label>
                            <select
                                id="gallery-project"
                                value={projectId}
                                onChange={(event) => setProjectId(event.target.value)}
                                className="min-w-52 max-w-full rounded-lg border border-white/10 bg-[#17171d] px-2.5 py-1.5 text-xs font-semibold text-white/85 outline-none transition-colors hover:border-white/20 focus:border-primary/60"
                            >
                                <option value="">All projects ({projects.reduce((sum, project) => sum + project.generations, 0)})</option>
                                {projects.map((project) => (
                                    <option key={project.id} value={project.id}>{project.name} ({project.generations})</option>
                                ))}
                            </select>
                            <span className="text-[11px] text-white/40">
                                {mediaTotals.images} image{mediaTotals.images === 1 ? '' : 's'} · {mediaTotals.videos} video{mediaTotals.videos === 1 ? '' : 's'}
                            </span>
                            <span className="ml-auto text-[11px] text-white/35">
                                {itemsError ? 'Not loaded' : items === null ? 'Loading…' : `Showing ${items.length} of ${total}`}
                            </span>
                        </div>
                    )}

                    {error && <p className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-300">{error}</p>}
                    {itemsError && <GalleryLoadError message={itemsError} onRetry={() => setItemsAttempt((attempt) => attempt + 1)} />}

                    {items === null && selected && (
                        <>
                            <GalleryLoading>Loading generations…</GalleryLoading>
                            <div aria-hidden="true" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                                {[...Array(8)].map((_, i) => <div key={i} className="aspect-video rounded-2xl bg-white/[0.03] animate-pulse" />)}
                            </div>
                        </>
                    )}

                    {items?.length === 0 && !itemsError && (
                        <div className="flex flex-col items-center justify-center py-24 text-center">
                            <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mb-4 text-white/25">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
                            </div>
                            <p className="text-sm text-white/45">Nothing here yet.</p>
                            <p className="text-xs text-white/25 mt-1">{activeProject ? `No visible generations in ${activeProject.name}.` : 'This creator hasn’t generated anything yet.'}</p>
                        </div>
                    )}

                    {items?.length > 0 && (
                        <>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                                {items.map((item) => (
                                    item.mediaType === 'image'
                                        ? <ImageCard key={item.taskId} item={item} onOpen={() => setLightbox(item)} />
                                        : <VideoCard key={item.taskId} item={item} exrAccess={exrAccess} onOpen={() => setLightbox(item)} />
                                ))}
                            </div>
                            {moreError && <div className="mt-4"><GalleryLoadError message={moreError} onRetry={loadMore} /></div>}
                            {nextBefore && (
                                <div className="flex justify-center py-8">
                                    <button
                                        type="button"
                                        onClick={loadMore}
                                        disabled={loadingMore}
                                        aria-busy={loadingMore}
                                        className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-white/65 transition-colors hover:border-white/25 hover:bg-white/[0.08] hover:text-white disabled:cursor-wait disabled:opacity-50"
                                    >
                                        {loadingMore ? 'Loading older generations…' : `Load older${total > items.length ? ` · ${total - items.length} remaining` : ''}`}
                                    </button>
                                </div>
                            )}
                            {!nextBefore && <div className="h-10" />}
                        </>
                    )}
                </main>
            </div>

            {lightbox && creator && (() => {
                const idx = items?.findIndex((i) => i.taskId === lightbox.taskId) ?? -1;
                return (
                    <Lightbox
                        key={lightbox.taskId}
                        item={lightbox}
                        creator={creator}
                        onClose={() => setLightbox(null)}
                        onReuse={() => reuseInStudio(router, lightbox)}
                        onExrReady={markExrReady}
                        exrAccess={exrAccess}
                        exrAccessRequesting={exrAccessRequesting}
                        onRequestExrAccess={askForExrAccess}
                        onPrev={idx > 0 ? () => setLightbox(items[idx - 1]) : null}
                        onNext={items && idx >= 0 && idx < items.length - 1 ? () => setLightbox(items[idx + 1]) : null}
                    />
                );
            })()}
        </div>
    );
}

// Bound each request, including reading its body. Leaving a creator cancels
// its work immediately; a stalled connection instead offers an explicit retry.
async function fetchGallery(url, signal, message) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, 20_000);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(message);
        return await response.json();
    } catch (error) {
        if (signal.aborted) throw error;
        throw new Error(timedOut ? 'The gallery request timed out. Try again.' : message);
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
    }
}

function GalleryLoading({ children }) {
    return (
        <div role="status" className="mb-4 flex items-center gap-2.5 py-3 text-sm text-white/65">
            <span aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/15 border-t-white/70 motion-reduce:animate-none" />
            {children}
        </div>
    );
}

function GalleryLoadError({ message, onRetry }) {
    return (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            <p>{message}</p>
            <button type="button" onClick={onRetry} className="shrink-0 rounded-md border border-red-300/25 px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-red-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300">Retry</button>
        </div>
    );
}

// cursor = { before, beforeId } straight from the API's nextBefore/nextBeforeId.
function galleryUrl(userId, projectId = '', cursor = null) {
    const params = new URLSearchParams({ user: userId });
    if (projectId) params.set('project', projectId);
    if (cursor?.before) params.set('before', cursor.before);
    if (cursor?.beforeId) params.set('beforeId', cursor.beforeId);
    return `/api/gallery?${params.toString()}`;
}

function CreatorCard({ c, me, selected, onClick }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`flex items-center gap-3 px-2.5 py-2.5 rounded-xl border text-left transition-colors ${selected ? 'border-primary/50 bg-primary/[0.07]' : 'border-transparent hover:border-white/10 hover:bg-white/[0.03]'}`}
        >
            <div className={`w-9 h-9 rounded-full bg-gradient-to-br ${gradientFor(c.id)} flex items-center justify-center text-sm font-black text-black/80 shrink-0`}>{initialOf(c)}</div>
            <div className="min-w-0 flex-1">
                <p className="text-xs font-bold truncate">
                    {c.name || c.email}
                    {c.id === me && <span className="ml-1.5 text-[8px] font-bold uppercase tracking-wider px-1 py-0.5 rounded bg-primary/15 text-primary align-middle">you</span>}
                </p>
                <p className="text-[10px] text-white/30 truncate">{c.last_at ? timeAgo(c.last_at) : 'no activity yet'}</p>
            </div>
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md shrink-0 ${c.generations > 0 ? 'bg-white/[0.06] text-white/60' : 'bg-white/[0.03] text-white/25'}`}>{c.generations}</span>
        </button>
    );
}
