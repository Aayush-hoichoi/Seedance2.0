'use client';

// Community Gallery — every creator on the platform and everything they've
// generated. Anyone can watch and REUSE any generation (prompt + refs +
// settings land back in the studio prompt bar); only the creator can delete,
// and that lives in the studio, not here.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { UserButton } from '@clerk/nextjs';
import { VideoCard, ImageCard, Lightbox, reuseInStudio, gradientFor, initialOf, timeAgo } from './shared.jsx';

export default function GalleryClient() {
    const router = useRouter();
    const [creators, setCreators] = useState(null); // null = loading
    const [me, setMe] = useState(null);
    const [selected, setSelected] = useState(null); // creator id
    const [items, setItems] = useState(null); // null = loading
    const [lightbox, setLightbox] = useState(null); // item
    const [error, setError] = useState(null);

    useEffect(() => {
        let alive = true;
        fetch('/api/gallery')
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load the gallery.'))))
            .then((d) => {
                if (!alive) return;
                setCreators(d.creators || []);
                setMe(d.me || null);
                // Land on the most recently active creator so the page opens
                // onto real work instead of an empty pane.
                const first = (d.creators || []).find((c) => c.generations > 0) || (d.creators || [])[0];
                if (first) setSelected(first.id);
            })
            .catch((e) => { if (alive) { setError(e.message); setCreators([]); } });
        return () => { alive = false; };
    }, []);

    useEffect(() => {
        if (!selected) return;
        let alive = true;
        setItems(null);
        setError(null);
        fetch(`/api/gallery?user=${encodeURIComponent(selected)}`)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load this creator’s work.'))))
            .then((d) => { if (alive) setItems(d.items || []); })
            .catch((e) => { if (alive) { setError(e.message); setItems([]); } });
        return () => { alive = false; };
    }, [selected]);

    const creator = useMemo(() => creators?.find((c) => c.id === selected) || null, [creators, selected]);

    return (
        <div className="relative min-h-screen w-full bg-app-bg text-white">
            {/* Top bar */}
            <header className="fixed top-0 inset-x-0 z-30 flex items-center justify-between px-4 sm:px-6 py-3.5 bg-app-bg/80 backdrop-blur-md border-b border-white/[0.06]">
                <div className="flex items-center gap-3 min-w-0">
                    <Link
                        href="/seedance"
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-white/10 bg-white/[0.04] text-white/70 hover:text-white hover:border-white/25 hover:bg-white/[0.08] transition-colors text-xs font-semibold shrink-0"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
                        Studio
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
                        Creators{creators ? ` · ${creators.length}` : ''}
                    </p>
                    {creators === null && [...Array(5)].map((_, i) => (
                        <div key={i} className="h-14 rounded-xl bg-white/[0.03] animate-pulse" />
                    ))}
                    {creators?.map((c) => (
                        <CreatorCard key={c.id} c={c} me={me} selected={c.id === selected} onClick={() => setSelected(c.id)} />
                    ))}
                    {creators?.length === 0 && <p className="px-2 text-xs text-white/35">No creators yet.</p>}
                </aside>

                {/* Main pane */}
                <main className="flex-1 min-w-0 px-4 sm:px-6 py-4">
                    {/* Mobile creator strip */}
                    <div className="md:hidden flex gap-2 overflow-x-auto pb-3 -mx-4 px-4">
                        {creators?.map((c) => (
                            <button
                                key={c.id}
                                type="button"
                                onClick={() => setSelected(c.id)}
                                className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-semibold whitespace-nowrap transition-colors ${c.id === selected ? 'border-primary/60 bg-primary/10 text-white' : 'border-white/10 bg-white/[0.03] text-white/60'}`}
                            >
                                <span className={`w-5 h-5 rounded-full bg-gradient-to-br ${gradientFor(c.id)} flex items-center justify-center text-[10px] font-black text-black/80`}>{initialOf(c)}</span>
                                {c.name || c.email}
                                <span className="text-white/35">{c.generations}</span>
                            </button>
                        ))}
                    </div>

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

                    {error && <p className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-300">{error}</p>}

                    {items === null && selected && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                            {[...Array(8)].map((_, i) => <div key={i} className="aspect-video rounded-2xl bg-white/[0.03] animate-pulse" />)}
                        </div>
                    )}

                    {items?.length === 0 && !error && (
                        <div className="flex flex-col items-center justify-center py-24 text-center">
                            <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mb-4 text-white/25">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
                            </div>
                            <p className="text-sm text-white/45">Nothing here yet.</p>
                            <p className="text-xs text-white/25 mt-1">This creator hasn’t generated anything yet.</p>
                        </div>
                    )}

                    {items?.length > 0 && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 pb-10">
                            {items.map((item) => (
                                item.mediaType === 'image'
                                    ? <ImageCard key={item.taskId} item={item} onOpen={() => setLightbox(item)} />
                                    : <VideoCard key={item.taskId} item={item} onOpen={() => setLightbox(item)} />
                            ))}
                        </div>
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
                        onPrev={idx > 0 ? () => setLightbox(items[idx - 1]) : null}
                        onNext={items && idx >= 0 && idx < items.length - 1 ? () => setLightbox(items[idx + 1]) : null}
                    />
                );
            })()}
        </div>
    );
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
