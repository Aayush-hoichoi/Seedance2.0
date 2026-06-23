'use client';

// Full-screen "All assets" overlay (higgsfield-style): every finished
// generation as a video tile, grouped by day, with multi-select. Selecting many
// and hitting Download streams a single .zip back (one selection → a raw .mp4).
// Reuses the studio's live `jobs` array — no refetch, opens instantly.

import { useEffect, useMemo, useState } from 'react';
import { downloadAssets } from '../../lib/seedance/downloadAssets.js';

// Calendar-day bucket key + a human label (Today / Yesterday / a date).
function startOfDay(ts) {
    const d = new Date(ts || 0);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function dayLabel(dayTs) {
    const today = startOfDay(Date.now());
    const diff = Math.round((today - startOfDay(dayTs)) / 86400000);
    if (diff <= 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    const d = new Date(dayTs);
    const opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
}

function groupByDay(videos) {
    const map = new Map();
    for (const v of videos) {
        const key = startOfDay(v.createdAt);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(v);
    }
    return [...map.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([key, items]) => ({ key, label: dayLabel(key), items }));
}

// A readable .mp4 name from the prompt (server de-dupes collisions in the zip).
function videoFileName(job, index) {
    const text = (job.userPrompt || job.prompt || '').trim().toLowerCase();
    let base = text.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    if (!base) base = `seedance-${String(job.taskId || job.id || index).slice(-8)}`;
    return `${base}.mp4`;
}

export default function AssetsPanel({ jobs, onClose }) {
    const videos = useMemo(
        () => (jobs || []).filter((j) => j.status === 'done' && j.videoUrl),
        [jobs],
    );
    const groups = useMemo(() => groupByDay(videos), [videos]);

    const [selected, setSelected] = useState(() => new Set());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    // Lock the body scroll while the overlay is open; Escape closes it.
    useEffect(() => {
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
        window.addEventListener('keydown', onKey);
        return () => {
            document.body.style.overflow = prev;
            window.removeEventListener('keydown', onKey);
        };
    }, [busy, onClose]);

    // Drop selections whose job vanished (e.g. removed from history meanwhile).
    useEffect(() => {
        setSelected((prev) => {
            const live = new Set(videos.map((v) => v.id));
            const next = new Set([...prev].filter((id) => live.has(id)));
            return next.size === prev.size ? prev : next;
        });
    }, [videos]);

    const allSelected = videos.length > 0 && selected.size === videos.length;

    const toggle = (id) => setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    const setMany = (ids, on) => setSelected((prev) => {
        const next = new Set(prev);
        for (const id of ids) { if (on) next.add(id); else next.delete(id); }
        return next;
    });

    const toggleAll = () => (allSelected ? setSelected(new Set()) : setSelected(new Set(videos.map((v) => v.id))));

    const runDownload = async (items) => {
        if (!items.length || busy) return;
        setBusy(true);
        setError(null);
        try {
            await downloadAssets(items);
        } catch (e) {
            setError(e.message || 'Download failed.');
        } finally {
            setBusy(false);
        }
    };

    const onDownloadSelected = () => {
        const byId = new Map(videos.map((v, i) => [v.id, videoFileName(v, i)]));
        const items = videos
            .filter((v) => selected.has(v.id))
            .map((v) => ({ url: v.videoUrl, name: byId.get(v.id) }));
        runDownload(items);
    };

    return (
        <div className="fixed inset-0 z-[80] flex flex-col bg-app-bg text-white animate-fade-in-up">
            <header className="shrink-0 flex items-center justify-between gap-4 h-16 px-5 sm:px-8 border-b border-white/[0.06]">
                <div className="min-w-0">
                    <h1 className="text-lg font-bold tracking-tight leading-none">All assets</h1>
                    <p className="mt-1 text-[11px] text-white/40">
                        {videos.length} video{videos.length === 1 ? '' : 's'} · saved on this device · links expire ~24h
                    </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {videos.length > 0 && (
                        <button
                            type="button"
                            onClick={toggleAll}
                            className="px-3 py-1.5 rounded-md text-xs font-semibold text-white/70 border border-white/10 bg-white/[0.04] hover:text-white hover:border-white/25 hover:bg-white/[0.08] transition-colors"
                        >
                            {allSelected ? 'Clear selection' : 'Select all'}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close assets"
                        title="Close"
                        className="p-2 rounded-md text-white/70 border border-white/10 bg-white/[0.04] hover:text-white hover:border-white/25 hover:bg-white/[0.08] transition-colors"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                    </button>
                </div>
            </header>

            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 sm:px-8 py-6 pb-32">
                {videos.length === 0 ? (
                    <EmptyState />
                ) : (
                    groups.map((g) => {
                        const ids = g.items.map((v) => v.id);
                        const groupAll = ids.every((id) => selected.has(id));
                        return (
                            <section key={g.key} className="mb-8">
                                <button
                                    type="button"
                                    onClick={() => setMany(ids, !groupAll)}
                                    className="group flex items-center gap-2 mb-3"
                                    title={groupAll ? 'Deselect this day' : 'Select this day'}
                                >
                                    <CheckBox checked={groupAll} />
                                    <span className="text-sm font-semibold text-white/80 group-hover:text-white transition-colors">{g.label}</span>
                                    <span className="text-[11px] text-white/30">· {g.items.length}</span>
                                </button>
                                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                                    {g.items.map((v, i) => (
                                        <AssetCard
                                            key={v.id}
                                            job={v}
                                            selected={selected.has(v.id)}
                                            onToggle={() => toggle(v.id)}
                                            onDownload={() => runDownload([{ url: v.videoUrl, name: videoFileName(v, i) }])}
                                            disabled={busy}
                                        />
                                    ))}
                                </div>
                            </section>
                        );
                    })
                )}
            </div>

            {selected.size > 0 && (
                <div className="fixed bottom-6 inset-x-0 mx-auto z-[81] w-fit max-w-[94vw] flex items-center gap-3 px-3 py-2.5 rounded-xl border border-white/10 bg-[#0a0a0a]/90 backdrop-blur-2xl shadow-2xl animate-fade-in-up">
                    <span className="pl-2 text-sm font-semibold whitespace-nowrap">{selected.size} selected</span>
                    {error && <span className="text-xs text-red-300 max-w-[36vw] truncate" title={error}>{error}</span>}
                    <button
                        type="button"
                        onClick={onDownloadSelected}
                        disabled={busy}
                        className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-black hover:bg-[#e5ff33] transition-colors disabled:opacity-60 disabled:cursor-wait"
                    >
                        {busy ? (
                            <><span className="animate-spin inline-block">◌</span> Zipping…</>
                        ) : (
                            <>
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
                                Download {selected.size > 1 ? 'zip' : ''}
                            </>
                        )}
                    </button>
                    <button
                        type="button"
                        onClick={() => setSelected(new Set())}
                        disabled={busy}
                        aria-label="Clear selection"
                        title="Clear selection"
                        className="p-2 rounded-md text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors disabled:opacity-40"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                    </button>
                </div>
            )}
        </div>
    );
}

// One video tile. Clicking the tile toggles selection; a hover Download button
// grabs just that clip. Hovering plays the video as a quick preview.
function AssetCard({ job, selected, onToggle, onDownload, disabled }) {
    const onEnter = (e) => { e.currentTarget.play?.().catch(() => {}); };
    const onLeave = (e) => { const v = e.currentTarget; v.pause?.(); try { v.currentTime = 0; } catch { /* noop */ } };
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onToggle}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
            title={job.prompt || job.userPrompt || job.meta || ''}
            className={`group relative aspect-video rounded-xl overflow-hidden border cursor-pointer transition-all ${selected ? 'border-primary ring-2 ring-primary/50' : 'border-white/10 hover:border-white/30'}`}
        >
            <video
                src={job.videoUrl}
                muted
                loop
                playsInline
                preload="metadata"
                onMouseEnter={onEnter}
                onMouseLeave={onLeave}
                className="w-full h-full object-cover bg-black"
            />
            {/* Dim unselected tiles slightly when any is selected — selected pops. */}
            <div className={`absolute inset-0 pointer-events-none transition-colors ${selected ? 'bg-primary/10' : 'bg-transparent'}`} />

            {/* Selection checkbox — always visible, top-left (matches the reference). */}
            <span className="absolute top-2 left-2 pointer-events-none">
                <CheckBox checked={selected} />
            </span>

            {/* Per-clip download — appears on hover, top-right. */}
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); if (!disabled) onDownload(); }}
                disabled={disabled}
                aria-label="Download this video"
                title="Download this video"
                className="absolute top-2 right-2 p-1.5 rounded-md bg-black/70 border border-white/15 text-white/80 opacity-0 group-hover:opacity-100 hover:text-primary transition-all backdrop-blur-sm disabled:opacity-40"
            >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
            </button>
        </div>
    );
}

function CheckBox({ checked }) {
    return (
        <span className={`flex items-center justify-center w-5 h-5 rounded-md border transition-colors ${checked ? 'bg-primary border-primary text-black' : 'bg-black/50 border-white/40 text-transparent'}`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
        </span>
    );
}

function EmptyState() {
    return (
        <div className="h-full min-h-[50vh] flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mb-4 text-primary/60">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" /></svg>
            </div>
            <h2 className="text-lg font-bold">No finished videos yet</h2>
            <p className="mt-1 text-sm text-white/40 max-w-xs">Generate a video and it'll show up here, ready to select and download.</p>
        </div>
    );
}
