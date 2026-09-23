'use client';

// Compare 2 or 4 takes in a grid, playing in parallel (GridPlayer-style).
// Slots fill from a local file (object URL — nothing is uploaded) or from the
// user's own generated videos in the studio gallery.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Film, FolderOpen, Pause, Play, Repeat, RotateCcw, Upload, Volume2, VolumeX, X } from 'lucide-react';
import StudioPicker from '../StudioPicker.jsx';

export default function CompareClient() {
    const [count, setCount] = useState(2);
    const [slots, setSlots] = useState(Array(4).fill(null)); // { src, label, objectUrl }
    const [playing, setPlaying] = useState(false);
    const [muted, setMuted] = useState(true);
    const [loop, setLoop] = useState(true);
    const [pickerFor, setPickerFor] = useState(null); // slot index or null
    const videoRefs = useRef([]);
    const fileRefs = useRef([]);

    // Object URLs live until the page unloads or the slot is replaced.
    useEffect(() => () => { slots.forEach((s) => s?.objectUrl && URL.revokeObjectURL(s.objectUrl)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const setSlot = (i, next) => setSlots((prev) => {
        if (prev[i]?.objectUrl) URL.revokeObjectURL(prev[i].objectUrl);
        const copy = [...prev];
        copy[i] = next;
        return copy;
    });

    const pickFile = (i, file) => {
        if (!file) return;
        const url = URL.createObjectURL(file);
        setSlot(i, { src: url, label: file.name, objectUrl: url });
    };

    const activeVideos = () => videoRefs.current.slice(0, count).filter(Boolean);

    const playAll = async () => {
        setPlaying(true);
        await Promise.allSettled(activeVideos().map((v) => v.play()));
    };
    const pauseAll = () => {
        setPlaying(false);
        activeVideos().forEach((v) => v.pause());
    };
    // Restart syncs the takes: everyone back to frame one, then play together.
    const restartAll = async () => {
        activeVideos().forEach((v) => { v.currentTime = 0; });
        await playAll();
    };

    const filled = slots.slice(0, count).filter(Boolean).length;

    return (
        <div className="min-h-screen w-full bg-app-bg px-4 py-6 text-ink sm:px-8">
            <div className="mx-auto max-w-6xl">
                <header className="mb-6 flex flex-wrap items-center gap-3">
                    <Link href="/tools" title="Back to tools" className="grid h-7 w-7 place-items-center rounded-md border border-line bg-paper-2 text-ink-3 transition-colors hover:text-ink">
                        <ArrowLeft size={14} />
                    </Link>
                    <h1 className="font-display text-xl font-semibold">Compare Video</h1>
                    <div className="ml-auto flex items-center gap-2">
                        <div className="flex items-center gap-1 rounded-lg border border-line bg-paper-2 p-1" role="tablist">
                            {[2, 4].map((n) => (
                                <button key={n} type="button" role="tab" aria-selected={count === n} onClick={() => { pauseAll(); setCount(n); }}
                                    className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${count === n ? 'bg-paper-3 text-ink' : 'text-ink-3 hover:text-ink-2'}`}>
                                    {n} videos
                                </button>
                            ))}
                        </div>
                    </div>
                </header>

                {/* 2 → side by side; 4 → 2×2. */}
                <div className="grid gap-2 sm:grid-cols-2">
                    {Array.from({ length: count }, (_, i) => (
                        <div key={i} className="relative overflow-hidden rounded-xl border border-line bg-black">
                            <input ref={(el) => { fileRefs.current[i] = el; }} type="file" accept="video/*" className="hidden"
                                onChange={(e) => { pickFile(i, e.target.files?.[0]); e.target.value = ''; }} />
                            {slots[i] ? (
                                <>
                                    <video
                                        ref={(el) => { videoRefs.current[i] = el; }}
                                        src={slots[i].src} muted={muted} loop={loop} playsInline preload="metadata"
                                        onClick={() => (playing ? pauseAll() : playAll())}
                                        className="aspect-video w-full cursor-pointer object-contain"
                                    />
                                    <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-black/70 to-transparent px-2.5 py-1.5 text-[11px] text-white/85">
                                        <span className="truncate" title={slots[i].label}>{i + 1} · {slots[i].label}</span>
                                        <button type="button" title="Clear this slot" onClick={() => { pauseAll(); setSlot(i, null); }}
                                            className="rounded p-0.5 text-white/70 transition-colors hover:bg-white/15 hover:text-white"><X size={13} /></button>
                                    </div>
                                </>
                            ) : (
                                <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 bg-paper-2 text-ink-3">
                                    <Film size={22} />
                                    <div className="flex flex-wrap items-center justify-center gap-2 text-xs font-semibold">
                                        <button type="button" onClick={() => fileRefs.current[i]?.click()}
                                            className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 transition-colors hover:bg-paper-3 hover:text-ink">
                                            <Upload size={13} /> Upload
                                        </button>
                                        <button type="button" onClick={() => setPickerFor(i)}
                                            className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 transition-colors hover:bg-paper-3 hover:text-ink">
                                            <FolderOpen size={13} /> From studio
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                    <button type="button" disabled={!filled} onClick={() => (playing ? pauseAll() : playAll())}
                        className="inline-flex items-center gap-2 rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40">
                        {playing ? <Pause size={15} /> : <Play size={15} />} {playing ? 'Pause all' : 'Play all'}
                    </button>
                    <button type="button" disabled={!filled} onClick={restartAll} title="Back to the first frame, in sync"
                        className="inline-flex items-center gap-1.5 rounded-md border border-line px-4 py-2.5 text-sm font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-40">
                        <RotateCcw size={14} /> Restart
                    </button>
                    <button type="button" onClick={() => setMuted((m) => !m)} title={muted ? 'Unmute' : 'Mute'}
                        className={`inline-flex items-center gap-1.5 rounded-md border px-4 py-2.5 text-sm font-semibold transition-colors ${muted ? 'border-line text-ink-3 hover:text-ink-2' : 'border-accent/40 bg-accent/10 text-ink'}`}>
                        {muted ? <VolumeX size={14} /> : <Volume2 size={14} />} Sound
                    </button>
                    <button type="button" onClick={() => setLoop((l) => !l)} title="Loop playback"
                        className={`inline-flex items-center gap-1.5 rounded-md border px-4 py-2.5 text-sm font-semibold transition-colors ${loop ? 'border-accent/40 bg-accent/10 text-ink' : 'border-line text-ink-3 hover:text-ink-2'}`}>
                        <Repeat size={14} /> Loop
                    </button>
                </div>
                <p className="mt-2 text-center text-[11px] text-ink-3">Uploads play locally — nothing is sent to a server. Click any video to play or pause everything.</p>
            </div>

            {pickerFor != null && (
                <StudioPicker
                    onClose={() => setPickerFor(null)}
                    onPick={(item) => {
                        setSlot(pickerFor, { src: item.archiveUrl, label: item.prompt?.slice(0, 80) || item.taskId });
                        setPickerFor(null);
                    }}
                />
            )}
        </div>
    );
}
