'use client';

// Liked — only the generations marked with a heart, across every creator.
// Same cards/lightbox as the gallery; each card carries its maker's chip.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { UserButton } from '@clerk/nextjs';
import { VideoCard, Lightbox, reuseInStudio } from '../gallery/shared.jsx';

export default function LikedClient() {
    const router = useRouter();
    const [items, setItems] = useState(null); // null = loading
    const [lightbox, setLightbox] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        let alive = true;
        fetch('/api/gallery?liked=1')
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load the liked assets.'))))
            .then((d) => { if (alive) setItems(d.items || []); })
            .catch((e) => { if (alive) { setError(e.message); setItems([]); } });
        return () => { alive = false; };
    }, []);

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
                        <h1 className="text-sm font-extrabold tracking-tight truncate flex items-center gap-1.5">
                            <span className="text-rose-400">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" /></svg>
                            </span>
                            Liked
                            {items?.length > 0 && <span className="text-white/35 font-semibold">· {items.length}</span>}
                        </h1>
                        <p className="text-[10px] text-white/35 truncate">The generations everyone loved</p>
                    </div>
                </div>
                <div className="flex items-center gap-2.5">
                    <Link
                        href="/gallery"
                        title="Browse every creator's work"
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-white/10 bg-white/[0.04] text-white/70 hover:text-white hover:border-white/25 hover:bg-white/[0.08] transition-colors text-xs font-semibold"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" /></svg>
                        Gallery
                    </Link>
                    <UserButton />
                </div>
            </header>

            <main className="pt-[4.7rem] px-4 sm:px-6 pb-10">
                {error && <p className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-300">{error}</p>}

                {items === null && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                        {[...Array(8)].map((_, i) => <div key={i} className="aspect-video rounded-2xl bg-white/[0.03] animate-pulse" />)}
                    </div>
                )}

                {items?.length === 0 && !error && (
                    <div className="flex flex-col items-center justify-center py-24 text-center">
                        <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mb-4 text-rose-400/40">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" /></svg>
                        </div>
                        <p className="text-sm text-white/45">Nothing liked yet.</p>
                        <p className="text-xs text-white/25 mt-1">Tap the heart on any generation — in the studio rail or history — and it lands here.</p>
                    </div>
                )}

                {items?.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                        {items.map((item) => (
                            <VideoCard key={item.taskId} item={item} creator={item.creator} onOpen={() => setLightbox(item)} />
                        ))}
                    </div>
                )}
            </main>

            {lightbox && (
                <Lightbox item={lightbox} creator={lightbox.creator} onClose={() => setLightbox(null)} onReuse={() => reuseInStudio(router, lightbox)} />
            )}
        </div>
    );
}
