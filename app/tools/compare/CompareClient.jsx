'use client';

// Compare 2 or 4 takes in a grid, playing in parallel (GridPlayer-style).
// Slots fill from a local file (object URL — nothing is uploaded) or from the
// user's own generated videos in the studio gallery.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Film, FolderOpen, Pause, Play, Repeat, RotateCcw, StepBack, StepForward, Upload, Volume2, VolumeX, X } from 'lucide-react';
import StudioPicker from '../StudioPicker.jsx';

const FRAME = 1 / 24; // step size — generated takes are 24 fps

export default function CompareClient() {
    const [count, setCount] = useState(2);
    const [slots, setSlots] = useState(Array(4).fill(null)); // { src, label, objectUrl }
    const [playing, setPlaying] = useState(false);
    const [muted, setMuted] = useState(true);
    const [loop, setLoop] = useState(true);
    const [speed, setSpeed] = useState(1);
    const [solo, setSolo] = useState(null); // slot index whose audio plays, or null
    const [time, setTime] = useState(0); // master playhead, drives the seek bar
    const [durs, setDurs] = useState({}); // slot index → duration (s)
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
        // Drops arrive unfiltered (no accept= like the file input), so ignore
        // anything that isn't a video instead of mounting a broken slot.
        if (!file || !file.type.startsWith('video/')) return;
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
        seekAll(0);
        await playAll();
    };

    // Any seek is also a re-sync: every video lands on the same moment, which
    // cures the slow drift of takes with unequal lengths.
    const seekAll = (t) => {
        activeVideos().forEach((v) => { v.currentTime = Math.min(t, v.duration || t); });
        setTime(t);
    };
    const stepFrame = (dir) => {
        pauseAll();
        seekAll(Math.max(0, time + dir * FRAME));
    };

    // Speed applies to every loaded video, and to late-loading ones via
    // onLoadedMetadata below.
    useEffect(() => { activeVideos().forEach((v) => { v.playbackRate = speed; }); }, [speed, slots, count]); // eslint-disable-line react-hooks/exhaustive-deps

    // Space = play/pause, ←/→ = one frame. Rebound each render so the handlers
    // never see stale state; skipped while typing or with the picker open.
    useEffect(() => {
        const onKey = (e) => {
            if (pickerFor != null || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
            if (e.code === 'Space') { e.preventDefault(); playing ? pauseAll() : playAll(); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); stepFrame(1); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); stepFrame(-1); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    const filled = slots.slice(0, count).filter(Boolean).length;
    const masterIdx = slots.slice(0, count).findIndex(Boolean);
    const maxDur = Math.max(0, ...slots.slice(0, count).map((s, i) => (s ? durs[i] || 0 : 0)));
    const fmtT = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

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
                        <div key={i}
                            // The whole slot is a drop target — dropping on a
                            // filled slot replaces its video.
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => { e.preventDefault(); pickFile(i, e.dataTransfer.files?.[0]); }}
                            className="relative overflow-hidden rounded-xl border border-line bg-black">
                            <input ref={(el) => { fileRefs.current[i] = el; }} type="file" accept="video/*" className="hidden"
                                onChange={(e) => { pickFile(i, e.target.files?.[0]); e.target.value = ''; }} />
                            {slots[i] ? (
                                <>
                                    <video
                                        ref={(el) => { videoRefs.current[i] = el; }}
                                        src={slots[i].src} muted={solo == null ? muted : solo !== i} loop={loop} playsInline preload="metadata"
                                        onClick={() => (playing ? pauseAll() : playAll())}
                                        onLoadedMetadata={(e) => {
                                            // Read the element NOW: React nulls e.currentTarget after the
                                            // handler returns, and the setDurs updater runs later.
                                            const v = e.currentTarget;
                                            v.playbackRate = speed;
                                            const d = v.duration;
                                            setDurs((prev) => ({ ...prev, [i]: d }));
                                        }}
                                        onTimeUpdate={(e) => { if (i === masterIdx) setTime(e.currentTarget.currentTime); }}
                                        className="aspect-video w-full cursor-pointer object-contain"
                                    />
                                    <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-black/70 to-transparent px-2.5 py-1.5 text-[11px] text-white/85">
                                        <span className="truncate" title={slots[i].label}>{i + 1} · {slots[i].label}</span>
                                        <div className="flex items-center gap-1">
                                            <button type="button" title={solo === i ? 'Mute this video' : 'Hear only this video'}
                                                onClick={() => setSolo((s) => (s === i ? null : i))}
                                                className={`rounded p-0.5 transition-colors hover:bg-white/15 ${solo === i ? 'text-accent-hi' : 'text-white/70 hover:text-white'}`}>
                                                {solo === i ? <Volume2 size={13} /> : <VolumeX size={13} />}
                                            </button>
                                            <button type="button" title="Clear this slot" onClick={() => { pauseAll(); setSlot(i, null); }}
                                                className="rounded p-0.5 text-white/70 transition-colors hover:bg-white/15 hover:text-white"><X size={13} /></button>
                                        </div>
                                    </div>
                                </>
                            ) : (
                                <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 bg-paper-2 text-ink-3">
                                    <Film size={22} />
                                    <span className="text-xs">Drop a video here, or</span>
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

                {/* Shared timeline: one slider seeks every video to the same
                    moment (which also re-syncs drifted takes). */}
                <div className="mt-4 flex items-center gap-3">
                    <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-3">{fmtT(time)}</span>
                    <input type="range" min={0} max={maxDur || 0} step={FRAME} value={Math.min(time, maxDur || 0)}
                        onChange={(e) => seekAll(Number(e.target.value))} disabled={!filled || !maxDur}
                        className="h-1.5 min-w-0 flex-1 cursor-pointer accent-accent disabled:cursor-default" />
                    <span className="w-14 shrink-0 font-mono text-[11px] tabular-nums text-ink-3">{fmtT(maxDur)}</span>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                    <button type="button" disabled={!filled} onClick={() => stepFrame(-1)} title="Back one frame (←)"
                        className="inline-flex items-center rounded-md border border-line px-3 py-2.5 text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-40">
                        <StepBack size={15} />
                    </button>
                    <button type="button" disabled={!filled} onClick={() => (playing ? pauseAll() : playAll())} title="Play / pause everything (space)"
                        className="inline-flex items-center gap-2 rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40">
                        {playing ? <Pause size={15} /> : <Play size={15} />} {playing ? 'Pause all' : 'Play all'}
                    </button>
                    <button type="button" disabled={!filled} onClick={() => stepFrame(1)} title="Forward one frame (→)"
                        className="inline-flex items-center rounded-md border border-line px-3 py-2.5 text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-40">
                        <StepForward size={15} />
                    </button>
                    <button type="button" disabled={!filled} onClick={restartAll} title="Back to the first frame, in sync"
                        className="inline-flex items-center gap-1.5 rounded-md border border-line px-4 py-2.5 text-sm font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-40">
                        <RotateCcw size={14} /> Restart
                    </button>
                    <div className="flex items-center gap-1 rounded-md border border-line bg-paper-2 p-1" title="Playback speed">
                        {[0.25, 0.5, 1, 1.5, 2, 2.25].map((s) => (
                            <button key={s} type="button" onClick={() => setSpeed(s)}
                                className={`rounded px-2 py-1.5 text-xs font-semibold transition-colors ${speed === s ? 'bg-paper-3 text-ink' : 'text-ink-3 hover:text-ink-2'}`}>
                                {s}×
                            </button>
                        ))}
                    </div>
                    <button type="button" onClick={() => { if (solo != null) { setSolo(null); setMuted(true); } else setMuted((m) => !m); }}
                        title={solo != null ? 'Mute (solo is on)' : muted ? 'Unmute all' : 'Mute all'}
                        className={`inline-flex items-center gap-1.5 rounded-md border px-4 py-2.5 text-sm font-semibold transition-colors ${(solo != null || !muted) ? 'border-accent/40 bg-accent/10 text-ink' : 'border-line text-ink-3 hover:text-ink-2'}`}>
                        {(solo != null || !muted) ? <Volume2 size={14} /> : <VolumeX size={14} />} Sound
                    </button>
                    <button type="button" onClick={() => setLoop((l) => !l)} title="Loop playback"
                        className={`inline-flex items-center gap-1.5 rounded-md border px-4 py-2.5 text-sm font-semibold transition-colors ${loop ? 'border-accent/40 bg-accent/10 text-ink' : 'border-line text-ink-3 hover:text-ink-2'}`}>
                        <Repeat size={14} /> Loop
                    </button>
                </div>
                <p className="mt-2 text-center text-[11px] text-ink-3">Space plays/pauses · ← → step one frame · the speaker on a video plays only its audio · uploads stay local, nothing is sent to a server.</p>
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
