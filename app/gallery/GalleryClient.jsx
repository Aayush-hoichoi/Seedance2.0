'use client';

// Community Gallery — every creator on the platform and everything they've
// generated. Anyone can watch and REUSE any generation (prompt + refs +
// settings land back in the studio prompt bar); only the creator can delete,
// and that lives in the studio, not here.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { UserButton } from '@clerk/nextjs';
import { MODES } from '../../lib/seedance/constants.js';

const modeNameOf = (id) => MODES.find((m) => m.id === id)?.name ?? null;

// Deterministic avatar gradient per user id — stable across reloads.
const GRADIENTS = [
    'from-cyan-400 to-blue-600',
    'from-fuchsia-400 to-purple-600',
    'from-amber-300 to-orange-600',
    'from-emerald-400 to-teal-600',
    'from-rose-400 to-red-600',
    'from-indigo-400 to-violet-600',
];
const gradientFor = (id) => GRADIENTS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % GRADIENTS.length];
const initialOf = (c) => (c.name || c.email || '?').trim().charAt(0).toUpperCase();

function timeAgo(iso) {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString();
}

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

    // Hand the full setup (prompt, refs, settings, mode) to the studio via
    // localStorage — the studio applies + clears it on mount. Presigned ref
    // URLs expire, so tosKey-backed refs are re-presigned first; otherwise an
    // old generation would be reused with dead reference links.
    const onReuse = async (item) => {
        const refs = await Promise.all((item.refs || []).map(async (r) => {
            if (!r?.tosKey) return r;
            try {
                const res = await fetch(`/api/byteplus/archive?key=${encodeURIComponent(r.tosKey)}`);
                const d = res.ok ? await res.json() : null;
                return d?.url ? { ...r, url: d.url, previewUrl: d.url } : r;
            } catch {
                return r;
            }
        }));
        try {
            localStorage.setItem('seedance:reuse', JSON.stringify({
                modeId: item.mode,
                style: item.style,
                userPrompt: item.userPrompt,
                prompt: item.prompt,
                refs: refs.length ? refs : null,
                options: { model: item.modelId, resolution: item.resolution, duration: item.duration, ratio: item.ratio },
            }));
        } catch { /* private mode etc. — the studio just opens blank */ }
        router.push('/seedance');
    };

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
                <UserButton />
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
                            <p className="text-xs text-white/25 mt-1">This creator hasn’t generated any videos.</p>
                        </div>
                    )}

                    {items?.length > 0 && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 pb-10">
                            {items.map((item) => (
                                <VideoCard key={item.taskId} item={item} onOpen={() => setLightbox(item)} />
                            ))}
                        </div>
                    )}
                </main>
            </div>

            {lightbox && creator && (
                <Lightbox item={lightbox} creator={creator} onClose={() => setLightbox(null)} onReuse={() => onReuse(lightbox)} />
            )}
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

// One generation in the grid: hover to preview, click for the full view.
function VideoCard({ item, onOpen }) {
    const videoRef = useRef(null);
    const prompt = item.userPrompt || item.prompt || '';
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onOpen}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
            onMouseEnter={() => videoRef.current?.play().catch(() => {})}
            onMouseLeave={() => { const v = videoRef.current; if (v) { v.pause(); v.currentTime = 0; } }}
            className="group relative aspect-video rounded-2xl overflow-hidden border border-white/10 bg-black/50 cursor-pointer hover:border-white/30 transition-all hover:shadow-xl hover:shadow-black/40"
            title={prompt}
        >
            <SmartVideo item={item} videoRef={videoRef} className="w-full h-full object-cover bg-black" muted playsInline preload="metadata" loop />
            {/* Bottom info gradient */}
            <div className="absolute inset-x-0 bottom-0 p-2.5 pt-8 bg-gradient-to-t from-black/85 to-transparent pointer-events-none">
                {prompt && <p className="text-[11px] leading-snug text-white/85 line-clamp-2">{prompt}</p>}
                <div className="flex items-center gap-1.5 mt-1.5 text-[9px] font-bold text-white/45">
                    <span className="px-1.5 py-0.5 rounded bg-white/10 text-white/70">{item.modelName}</span>
                    {item.resolution && <span>{item.resolution}</span>}
                    {item.duration ? <span>{item.duration}s</span> : null}
                    <span className="ml-auto font-medium">{timeAgo(item.createdAt)}</span>
                </div>
            </div>
            {item.liked && (
                <span className="absolute top-2 left-2 w-5 h-5 rounded-full bg-black/60 border border-rose-400/40 text-rose-400 flex items-center justify-center">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" /></svg>
                </span>
            )}
        </div>
    );
}

// Video with a two-step URL fallback: the archived TOS copy (long-lived,
// presigned server-side) → the live ModelArk task record (~24h) → a
// placeholder. `videoRef`/`onUrl` let parents control playback / download.
function SmartVideo({ item, videoRef, onUrl, className, ...videoProps }) {
    const [src, setSrc] = useState(item.archiveUrl || null);
    const [phase, setPhase] = useState(item.archiveUrl ? 'archive' : 'task');
    const [taskStatus, setTaskStatus] = useState(null);
    const triedTask = useRef(false);

    const fetchTask = () => {
        if (triedTask.current) { setPhase('dead'); setSrc(null); return; }
        triedTask.current = true;
        fetch(`/api/byteplus/contents/generations/tasks/${encodeURIComponent(item.taskId)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                const url = d?.content?.video_url;
                if (url) { setSrc(url); setPhase('live'); }
                else { setTaskStatus(d?.status || null); setPhase('dead'); setSrc(null); }
            })
            .catch(() => { setPhase('dead'); setSrc(null); });
    };

    useEffect(() => {
        if (!item.archiveUrl) fetchTask();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => { if (src) onUrl?.(src); }, [src, onUrl]);

    if (phase === 'dead') {
        const rendering = ['queued', 'running'].includes(taskStatus);
        return (
            <div className={`${className} flex flex-col items-center justify-center gap-1.5 text-white/25`}>
                {rendering ? (
                    <>
                        <span className="animate-spin inline-block text-primary text-sm">◌</span>
                        <span className="text-[10px] font-semibold text-white/40">Still rendering…</span>
                    </>
                ) : (
                    <>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
                        <span className="text-[10px] font-semibold">Video no longer available</span>
                    </>
                )}
            </div>
        );
    }
    if (!src) return <div className={`${className} animate-pulse bg-white/[0.03]`} />;
    return (
        <video
            ref={videoRef}
            src={src}
            className={className}
            onError={() => { if (phase === 'archive') fetchTask(); else { setPhase('dead'); setSrc(null); } }}
            {...videoProps}
        />
    );
}

// Full view: the video big, everything about the generation beside it, and
// the Reuse action that loads this exact setup back into the studio.
function Lightbox({ item, creator, onClose, onReuse }) {
    const [dlUrl, setDlUrl] = useState(null);
    const hasBoth = !!item.userPrompt && !!item.prompt && item.userPrompt !== item.prompt;
    const meta = [
        item.modelName,
        item.resolution,
        item.duration ? `${item.duration}s` : null,
        item.ratio && item.ratio !== 'adaptive' ? item.ratio : null,
        modeNameOf(item.mode),
    ].filter(Boolean);
    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm p-4 animate-fade-in-up" onClick={onClose}>
            <button type="button" onClick={onClose} aria-label="Close" className="absolute top-5 right-5 p-2.5 bg-white/10 hover:bg-white/20 rounded-full border border-white/10 text-white transition-colors z-10">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
            <div
                className="flex flex-col lg:flex-row gap-4 w-full max-w-6xl max-h-[92vh] overflow-y-auto custom-scrollbar lg:overflow-visible"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex-1 min-w-0 flex items-start justify-center">
                    <div className="rounded-2xl overflow-hidden border border-white/10 bg-black shadow-2xl w-full">
                        <SmartVideo item={item} onUrl={setDlUrl} className="w-full max-h-[70vh] aspect-video object-contain bg-black" controls autoPlay loop playsInline />
                    </div>
                </div>
                <div className="w-full lg:w-80 xl:w-96 shrink-0 flex flex-col rounded-2xl border border-white/10 bg-white/[0.02] backdrop-blur-sm overflow-hidden lg:max-h-[70vh]">
                    {/* Creator + meta */}
                    <div className="px-4 py-3 border-b border-white/[0.06] shrink-0">
                        <div className="flex items-center gap-2.5">
                            <div className={`w-8 h-8 rounded-full bg-gradient-to-br ${gradientFor(creator.id)} flex items-center justify-center text-xs font-black text-black/80 shrink-0`}>{initialOf(creator)}</div>
                            <div className="min-w-0">
                                <p className="text-xs font-bold truncate">{creator.name || creator.email}</p>
                                <p className="text-[10px] text-white/35">{timeAgo(item.createdAt)}</p>
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5 mt-3">
                            {meta.map((m) => (
                                <span key={m} className="px-2 py-0.5 rounded-md bg-white/[0.06] text-[10px] font-semibold text-white/60">{m}</span>
                            ))}
                        </div>
                    </div>
                    {/* Prompts */}
                    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 py-3 flex flex-col gap-3">
                        {item.userPrompt && (
                            <div>
                                <p className="text-[9px] font-bold uppercase tracking-wider text-white/30 pb-1">Prompt</p>
                                <p className="text-xs leading-relaxed text-white/70 whitespace-pre-wrap break-words">{item.userPrompt}</p>
                            </div>
                        )}
                        {hasBoth && (
                            <div>
                                <p className="text-[9px] font-bold uppercase tracking-wider text-white/30 pb-1">GPT-4o brief · sent to the model</p>
                                <p className="text-xs leading-relaxed text-white/50 whitespace-pre-wrap break-words">{item.prompt}</p>
                            </div>
                        )}
                        {!item.userPrompt && !hasBoth && item.prompt && (
                            <div>
                                <p className="text-[9px] font-bold uppercase tracking-wider text-white/30 pb-1">Prompt</p>
                                <p className="text-xs leading-relaxed text-white/70 whitespace-pre-wrap break-words">{item.prompt}</p>
                            </div>
                        )}
                        {item.refs?.length > 0 && <RefStrip refs={item.refs} />}
                    </div>
                    {/* Actions */}
                    <div className="px-4 py-3 border-t border-white/[0.06] flex gap-2 shrink-0">
                        <button
                            type="button"
                            onClick={onReuse}
                            title="Load this prompt, references and settings into the studio"
                            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary/15 border border-primary/40 text-primary text-xs font-bold hover:bg-primary/25 transition-colors"
                        >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 4v6h6M23 20v-6h-6" /><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" /></svg>
                            Reuse in Studio
                        </button>
                        {dlUrl && (
                            <a
                                href={dlUrl}
                                download
                                title="Download this video"
                                className="flex items-center justify-center px-3 py-2 rounded-lg border border-white/10 bg-white/[0.04] text-white/70 hover:text-white hover:border-white/25 transition-colors"
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
                            </a>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

// Reference assets attached to the generation. Presigned preview links expire,
// so tosKey-backed refs are refreshed via the archive re-presign endpoint.
function RefStrip({ refs }) {
    const [items, setItems] = useState(refs);
    useEffect(() => {
        let alive = true;
        Promise.all(refs.map(async (r) => {
            if (!r?.tosKey) return r;
            try {
                const res = await fetch(`/api/byteplus/archive?key=${encodeURIComponent(r.tosKey)}`);
                const d = res.ok ? await res.json() : null;
                return d?.url ? { ...r, previewUrl: d.url } : r;
            } catch {
                return r;
            }
        })).then((next) => { if (alive) setItems(next); });
        return () => { alive = false; };
    }, [refs]);

    const counters = {};
    return (
        <div>
            <p className="text-[9px] font-bold uppercase tracking-wider text-white/30 pb-1.5">References · {items.length}</p>
            <div className="flex gap-2 flex-wrap">
                {items.map((r, i) => {
                    counters[r.kind] = (counters[r.kind] || 0) + 1;
                    const tag = `${r.kind === 'image' ? 'Image' : r.kind === 'video' ? 'Video' : 'Audio'} ${counters[r.kind]}`;
                    return (
                        <div key={i} className="relative w-14 h-14 rounded-lg overflow-hidden border border-white/10 bg-black/40" title={r.name || tag}>
                            {r.kind === 'image' && r.previewUrl ? (
                                <img src={r.previewUrl} alt={r.name || tag} className="w-full h-full object-cover" />
                            ) : r.kind === 'video' && r.previewUrl ? (
                                <video src={r.previewUrl} muted playsInline preload="metadata" className="w-full h-full object-cover bg-black" />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center text-primary/60">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>
                                </div>
                            )}
                            <span className="absolute bottom-0 inset-x-0 px-1 py-0.5 bg-black/75 text-[7px] font-black text-primary text-center truncate pointer-events-none">{tag}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
