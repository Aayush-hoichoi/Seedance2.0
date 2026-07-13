'use client';

// Full-screen overlay with two tabs:
//   • All assets — every finished generation as a video tile, grouped by day,
//     multi-select → Download (one → mp4, many → zip).
//   • Bin — generations the user crossed out. Soft-deleted (still in storage),
//     so they can be Restored or Deleted permanently here.
// Reuses the studio's live jobs — no refetch, opens instantly.

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

function groupByDay(items) {
    const map = new Map();
    for (const v of items) {
        const key = startOfDay(v.createdAt);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(v);
    }
    return [...map.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([key, list]) => ({ key, label: dayLabel(key), items: list }));
}

// A readable .mp4 name from the prompt (server de-dupes collisions in the zip).
function videoFileName(job, index) {
    const text = (job.userPrompt || job.prompt || '').trim().toLowerCase();
    let base = text.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    if (!base) base = `seedance-${String(job.taskId || job.id || index).slice(-8)}`;
    return `${base}.mp4`;
}

export default function AssetsPanel({ jobs, binned, onBin, onRestore, onDeleteForever, onClose }) {
    const [view, setView] = useState('assets'); // 'assets' | 'bin'
    const [selected, setSelected] = useState(() => new Set());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const assets = useMemo(
        () => (jobs || []).filter((j) => j.status === 'done' && j.videoUrl),
        [jobs],
    );
    const binItems = useMemo(() => binned || [], [binned]);
    const source = view === 'assets' ? assets : binItems;
    const groups = useMemo(() => groupByDay(source), [source]);

    // Lock body scroll while open; Escape closes.
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

    // Switching tabs clears the selection + any stale message.
    useEffect(() => { setSelected(new Set()); setError(null); }, [view]);

    // Drop selections whose item left the current view (binned/restored/removed).
    useEffect(() => {
        setSelected((prev) => {
            const live = new Set(source.map((v) => v.id));
            const next = new Set([...prev].filter((id) => live.has(id)));
            return next.size === prev.size ? prev : next;
        });
    }, [source]);

    const allSelected = source.length > 0 && selected.size === source.length;

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
    const toggleAll = () => (allSelected ? setSelected(new Set()) : setSelected(new Set(source.map((v) => v.id))));

    const selectedJobs = source.filter((v) => selected.has(v.id));

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

    const onDownloadSelected = () => runDownload(
        selectedJobs.map((v, i) => ({ url: v.videoUrl, name: videoFileName(v, i) })),
    );
    const onDownloadOne = (v, i) => runDownload([{ url: v.videoUrl, name: videoFileName(v, i) }]);

    const binMany = (ids) => { ids.forEach((id) => onBin(id)); setSelected(new Set()); };
    const restoreMany = (ids) => { ids.forEach((id) => onRestore(id)); setSelected(new Set()); };

    const deleteForever = async (ids) => {
        if (!ids.length || busy) return;
        const ok = window.confirm(
            `Permanently delete ${ids.length} video${ids.length === 1 ? '' : 's'}? This can't be undone.`,
        );
        if (!ok) return;
        setBusy(true);
        try {
            await Promise.all(ids.map((id) => Promise.resolve(onDeleteForever(id))));
            setSelected(new Set());
        } finally {
            setBusy(false);
        }
    };

    const isBin = view === 'bin';

    return (
        <div className="fixed inset-0 z-[80] flex flex-col bg-app-bg text-white animate-fade-in-up">
            <header className="shrink-0 flex items-center justify-between gap-4 h-16 px-5 sm:px-8 border-b border-white/[0.06]">
                <div className="flex items-center gap-1">
                    <Tab active={!isBin} onClick={() => setView('assets')} label="All assets" count={assets.length} />
                    <Tab active={isBin} onClick={() => setView('bin')} label="Bin" count={binItems.length} />
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {source.length > 0 && (
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
                        aria-label="Close"
                        title="Close"
                        className="p-2 rounded-md text-white/70 border border-white/10 bg-white/[0.04] hover:text-white hover:border-white/25 hover:bg-white/[0.08] transition-colors"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                    </button>
                </div>
            </header>

            <p className="shrink-0 px-5 sm:px-8 pt-3 text-[11px] text-white/40">
                {isBin
                    ? `${binItems.length} in the bin · restore them, or delete permanently`
                    : `${assets.length} video${assets.length === 1 ? '' : 's'} · saved on this device · links expire ~24h`}
            </p>

            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 sm:px-8 py-5 pb-32">
                {source.length === 0 ? (
                    <EmptyState isBin={isBin} />
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
                                            isBin={isBin}
                                            selected={selected.has(v.id)}
                                            disabled={busy}
                                            onToggle={() => toggle(v.id)}
                                            onDownload={() => onDownloadOne(v, i)}
                                            onBin={() => onBin(v.id)}
                                            onRestore={() => onRestore(v.id)}
                                            onDelete={() => deleteForever([v.id])}
                                        />
                                    ))}
                                </div>
                            </section>
                        );
                    })
                )}
            </div>

            {selected.size > 0 && (
                <div className="fixed bottom-6 inset-x-0 mx-auto z-[81] w-fit max-w-[94vw] flex items-center gap-2 px-3 py-2.5 rounded-xl border border-white/10 bg-paper-1/90 backdrop-blur-2xl shadow-2xl animate-fade-in-up">
                    <span className="pl-2 pr-1 text-sm font-semibold whitespace-nowrap tabular-nums">{selected.size} selected</span>
                    {error && <span className="text-xs text-danger max-w-[34vw] truncate" title={error}>{error}</span>}
                    {isBin ? (
                        <>
                            <button
                                type="button"
                                onClick={() => restoreMany([...selected])}
                                disabled={busy}
                                className="flex items-center gap-1.5 rounded-md bg-white/10 px-3.5 py-2 text-sm font-semibold text-white hover:bg-white/20 transition-colors disabled:opacity-60"
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7v6h6" /><path d="M3.51 13a9 9 0 1 0 2.13-9.36L3 7" /></svg>
                                Restore
                            </button>
                            <button
                                type="button"
                                onClick={() => deleteForever([...selected])}
                                disabled={busy}
                                className="flex items-center gap-1.5 rounded-md bg-danger/15 px-3.5 py-2 text-sm font-semibold text-danger border border-danger/30 hover:bg-danger/25 transition-colors disabled:opacity-60"
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
                                Delete forever
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                type="button"
                                onClick={onDownloadSelected}
                                disabled={busy}
                                className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-hi transition-colors disabled:opacity-60 disabled:cursor-wait"
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
                                onClick={() => binMany([...selected])}
                                disabled={busy}
                                title="Move to bin"
                                className="flex items-center gap-1.5 rounded-md bg-white/10 px-3.5 py-2 text-sm font-semibold text-white hover:bg-white/20 transition-colors disabled:opacity-60"
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
                                Move to bin
                            </button>
                        </>
                    )}
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

function Tab({ active, onClick, label, count }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`px-3 py-1.5 rounded-md text-sm font-bold tracking-tight transition-colors ${active ? 'bg-white/[0.06] text-white' : 'text-white/40 hover:text-white/80'}`}
        >
            {label}
            {count > 0 && <span className={`ml-1.5 text-xs font-semibold ${active ? 'text-white/40' : 'text-white/25'}`}>{count}</span>}
        </button>
    );
}

// One video tile. Clicking toggles selection. Hover reveals view-specific
// quick actions (Download in Assets; Restore + Delete forever in the Bin) and
// plays the clip as a preview.
function AssetCard({ job, isBin, selected, disabled, onToggle, onDownload, onBin, onRestore, onDelete }) {
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
            {job.videoUrl ? (
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
            ) : (
                <div className="w-full h-full flex items-center justify-center bg-black/50 px-2 text-center">
                    <span className="text-[10px] text-white/40 line-clamp-3">{job.error || job.prompt || 'No video'}</span>
                </div>
            )}
            <div className={`absolute inset-0 pointer-events-none transition-colors ${selected ? 'bg-primary/10' : 'bg-transparent'}`} />

            <span className="absolute top-2 left-2 pointer-events-none">
                <CheckBox checked={selected} />
            </span>

            <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {isBin ? (
                    <>
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); if (!disabled) onRestore(); }}
                            disabled={disabled}
                            aria-label="Restore"
                            title="Restore to history"
                            className="p-1.5 rounded-md bg-black/70 border border-white/15 text-white/80 hover:text-primary transition-colors backdrop-blur-sm disabled:opacity-40"
                        >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7v6h6" /><path d="M3.51 13a9 9 0 1 0 2.13-9.36L3 7" /></svg>
                        </button>
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); if (!disabled) onDelete(); }}
                            disabled={disabled}
                            aria-label="Delete permanently"
                            title="Delete permanently"
                            className="p-1.5 rounded-md bg-black/70 border border-white/15 text-white/80 hover:text-danger transition-colors backdrop-blur-sm disabled:opacity-40"
                        >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
                        </button>
                    </>
                ) : (
                    <>
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); if (!disabled) onDownload(); }}
                            disabled={disabled}
                            aria-label="Download this video"
                            title="Download this video"
                            className="p-1.5 rounded-md bg-black/70 border border-white/15 text-white/80 hover:text-primary transition-colors backdrop-blur-sm disabled:opacity-40"
                        >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
                        </button>
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); if (!disabled) onBin(); }}
                            disabled={disabled}
                            aria-label="Move to bin"
                            title="Move to bin"
                            className="p-1.5 rounded-md bg-black/70 border border-white/15 text-white/80 hover:text-danger transition-colors backdrop-blur-sm disabled:opacity-40"
                        >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                        </button>
                    </>
                )}
            </div>
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

function EmptyState({ isBin }) {
    return (
        <div className="h-full min-h-[50vh] flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mb-4 text-primary/60">
                {isBin ? (
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
                ) : (
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" /></svg>
                )}
            </div>
            <h2 className="text-lg font-bold font-display">{isBin ? 'The bin is empty' : 'No finished videos yet'}</h2>
            <p className="mt-1 text-sm text-white/40 max-w-xs">
                {isBin
                    ? 'Videos you cross out from history land here — restore them or delete them for good.'
                    : "Generate a video and it'll show up here, ready to select and download."}
            </p>
        </div>
    );
}
