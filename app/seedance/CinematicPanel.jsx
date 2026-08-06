'use client';

// Cinematic Cameras — centered modal for image mode. Pick a camera body, lens,
// focal length and aperture (via presets or the manual tiles); on Apply the
// active setup is lifted to the studio, where the enhancer (style 'cinematic_camera')
// weaves it into the image prompt. All / Recommended / Saved tabs filter the
// preset list; custom setups persist per-device (lib/seedance/cameraPresets.js).

import { useEffect, useRef, useState } from 'react';
import {
    CAMERAS, LENSES, APERTURES, FOCAL_STOPS,
    CINEMATIC_PRESETS, DEFAULT_SETUP, presetToSetup, sanitizeSetup, summarize, findCamera, findLens,
} from '../../lib/seedance/cinematic.mjs';
import { loadPresets, savePresets } from '../../lib/seedance/cameraPresets.js';
import { ApertureIris, CameraGlyph, LensGlyph } from './cinematicIcons.jsx';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';

const TABS = [
    { id: 'all', label: 'All' },
    { id: 'recommended', label: 'Recommended' },
    { id: 'saved', label: 'Saved' },
];

const ROW_H = 46; // px per reel row

// A vertical "slot-machine" reel: scroll up/down through the options and whatever
// lands in the centre band is selected; neighbours fade above and below. Only the
// reel scrolls (never the modal). Clicking a row selects it; an external change
// (e.g. applying a preset) scrolls the active row back to the centre.
function ReelPicker({ items, getId, activeId, onPick, renderItem }) {
    const ref = useRef(null);
    const idx = Math.max(0, items.findIndex((it) => getId(it) === activeId));

    // Centre the active row on open / external change — but skip tiny
    // corrections so it never fights the user's own scroll+snap.
    useEffect(() => {
        const el = ref.current;
        if (el && Math.abs(el.scrollTop - idx * ROW_H) > 2) el.scrollTop = idx * ROW_H;
    }, [idx]);

    // After the scroll settles (snap done), select whichever row is centred.
    const onScroll = () => {
        const el = ref.current;
        if (!el) return;
        clearTimeout(el._t);
        el._t = setTimeout(() => {
            const i = Math.max(0, Math.min(items.length - 1, Math.round(el.scrollTop / ROW_H)));
            const id = getId(items[i]);
            if (id !== activeId) onPick(id);
        }, 90);
    };

    return (
        <div className="relative w-full" style={{ height: ROW_H * 3 }}>
            {/* centre selection band */}
            <div className="pointer-events-none absolute inset-x-1 top-1/2 z-10 -translate-y-1/2 rounded-lg border border-primary/40 bg-primary/[0.06]" style={{ height: ROW_H }} />
            <div
                ref={ref}
                onScroll={onScroll}
                className="h-full snap-y snap-mandatory overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                style={{
                    maskImage: 'linear-gradient(to bottom, transparent, #000 34%, #000 66%, transparent)',
                    WebkitMaskImage: 'linear-gradient(to bottom, transparent, #000 34%, #000 66%, transparent)',
                }}
            >
                <div style={{ height: ROW_H }} aria-hidden />
                {items.map((it) => {
                    const active = getId(it) === activeId;
                    return (
                        <button
                            key={getId(it)}
                            type="button"
                            onClick={() => onPick(getId(it))}
                            className={`flex w-full snap-center items-center justify-center text-white transition-opacity ${active ? 'opacity-100' : 'opacity-30 hover:opacity-60'}`}
                            style={{ height: ROW_H }}
                        >
                            {renderItem(it, active)}
                        </button>
                    );
                })}
                <div style={{ height: ROW_H }} aria-hidden />
            </div>
        </div>
    );
}

// A tile = label on top, the reel in the middle, the selected value's name below.
function ReelTile({ label, name, sub, children }) {
    return (
        <div className="flex flex-col items-center gap-1 rounded-xl border border-white/[0.08] bg-white/[0.03] px-2 pt-3 pb-3 text-center">
            <div className="text-[10px] font-bold uppercase tracking-wider text-white/40">{label}</div>
            {children}
            <div className="mt-1 flex min-h-[2.4rem] flex-col items-center justify-start">
                {name && <div className="text-sm font-semibold leading-tight text-white line-clamp-2">{name}</div>}
                {sub && <div className="text-[10px] uppercase tracking-wide text-white/35">{sub}</div>}
            </div>
        </div>
    );
}

const CloseIcon = () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>);

export default function CinematicPanel({ open, setup, onApply, onClose }) {
    const [tab, setTab] = useState('all');
    const [draft, setDraft] = useState(DEFAULT_SETUP);
    const [saved, setSaved] = useState([]);
    const [toDelete, setToDelete] = useState(null);

    // Each time the panel opens, seed the draft from the active setup (or the
    // default) and reload saved presets from localStorage.
    useEffect(() => {
        if (!open) return;
        setDraft(sanitizeSetup(setup) || DEFAULT_SETUP);
        setSaved(loadPresets());
        setTab('all');
        setToDelete(null);
    }, [open, setup]);

    if (!open) return null;

    // A manual tweak clears the active-preset link (draft no longer matches one).
    const set = (patch) => setDraft((d) => ({ ...d, ...patch, presetId: null }));
    const applyPreset = (p) => setDraft(sanitizeSetup(presetToSetup(p)));

    const saveSetup = () => {
        const name = (typeof window !== 'undefined' ? window.prompt('Name this setup', summarize(draft) || 'My Look') : '')?.trim();
        if (!name) return;
        const preset = { id: `custom-${Date.now()}`, name, cameraId: draft.cameraId, lensId: draft.lensId, focalLength: draft.focalLength, aperture: draft.aperture };
        const next = [preset, ...saved].slice(0, 50);
        savePresets(next);
        setSaved(next);
        setDraft((d) => ({ ...d, presetId: preset.id }));
        setTab('saved');
    };

    const removeSaved = () => {
        if (!toDelete) return;
        const next = saved.filter((p) => p.id !== toDelete.id);
        savePresets(next);
        setSaved(next);
        setToDelete(null);
    };

    const presetList = tab === 'recommended'
        ? CINEMATIC_PRESETS.filter((p) => p.recommended)
        : tab === 'saved' ? saved : CINEMATIC_PRESETS;

    return (
        <>
            <ConfirmDialog
                open={!!toDelete}
                onOpenChange={(nextOpen) => { if (!nextOpen) setToDelete(null); }}
                title={`Delete “${toDelete?.name || 'this setup'}”?`}
                description="This saved cinematic setup will be removed from this device. This action cannot be undone."
                confirmLabel="Delete setup"
                onConfirm={removeSaved}
            />
            <div
                className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
                onClick={onClose}
            >
            <div
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-3xl overflow-hidden rounded-2xl border border-white/10 bg-paper-1 shadow-2xl"
            >
                {/* header: tabs + close */}
                <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
                    <div className="flex items-center gap-1 rounded-full bg-black/30 p-1">
                        {TABS.map((t) => (
                            <button
                                key={t.id}
                                type="button"
                                onClick={() => setTab(t.id)}
                                className={`rounded-full px-3.5 py-1 text-xs font-semibold transition-colors ${tab === t.id ? 'bg-white text-black' : 'text-white/60 hover:text-white'}`}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>
                    <div className="flex items-center gap-3">
                        <span className="hidden text-xs text-white/40 sm:inline">{summarize(draft)}</span>
                        <button type="button" onClick={onClose} className="rounded-full p-1.5 text-white/50 hover:bg-white/10 hover:text-white" aria-label="Close">
                            <CloseIcon />
                        </button>
                    </div>
                </div>

                {/* editor reels — scroll each column like a slot machine */}
                <div className="grid grid-cols-2 gap-3 px-4 pb-3 pt-3 sm:grid-cols-4">
                    <ReelTile label="Camera" name={findCamera(draft.cameraId)?.name} sub={findCamera(draft.cameraId)?.type}>
                        <ReelPicker
                            items={CAMERAS} getId={(c) => c.id} activeId={draft.cameraId} onPick={(id) => set({ cameraId: id })}
                            renderItem={(c, active) => <CameraGlyph type={c.type} size={active ? 36 : 26} />}
                        />
                    </ReelTile>
                    <ReelTile label="Lens" name={findLens(draft.lensId)?.name} sub={findLens(draft.lensId)?.type}>
                        <ReelPicker
                            items={LENSES} getId={(l) => l.id} activeId={draft.lensId} onPick={(id) => set({ lensId: id })}
                            renderItem={(l, active) => <LensGlyph type={l.type} size={active ? 36 : 26} />}
                        />
                    </ReelTile>
                    <ReelTile label="Focal length" name="millimetres">
                        <ReelPicker
                            items={FOCAL_STOPS} getId={(f) => f}
                            activeId={FOCAL_STOPS.reduce((b, s) => (Math.abs(s - draft.focalLength) < Math.abs(b - draft.focalLength) ? s : b), FOCAL_STOPS[0])}
                            onPick={(f) => set({ focalLength: f })}
                            renderItem={(f, active) => <span className={`font-bold tabular-nums ${active ? 'text-2xl' : 'text-base'}`}>{f}</span>}
                        />
                    </ReelTile>
                    <ReelTile label="Aperture" name={`f/${draft.aperture}`}>
                        <ReelPicker
                            items={APERTURES} getId={(a) => a} activeId={draft.aperture} onPick={(a) => set({ aperture: a })}
                            renderItem={(a, active) => <ApertureIris aperture={a} size={active ? 36 : 26} />}
                        />
                    </ReelTile>
                </div>

                {/* preset list */}
                <div className="max-h-[34vh] overflow-y-auto px-4 pb-2 custom-scrollbar">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {presetList.length === 0 && (
                            <div className="col-span-full py-6 text-center text-sm text-white/40">No saved setups yet — tune the controls and hit “Save setup”.</div>
                        )}
                        {presetList.map((p) => {
                            const active = draft.presetId === p.id;
                            return (
                                <button
                                    key={p.id}
                                    type="button"
                                    onClick={() => applyPreset(p)}
                                    className={`group relative rounded-lg border px-3 py-2.5 text-left transition-colors ${active ? 'border-primary/40 bg-primary/10' : 'border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.06]'}`}
                                >
                                    <div className={`text-sm font-semibold ${active ? 'text-primary' : 'text-white'}`}>{p.name}</div>
                                    <div className="text-[11px] text-white/45">{findCamera(p.cameraId)?.name} · {p.focalLength}mm · f/{p.aperture}</div>
                                    {tab === 'saved' && (
                                        <span
                                            onClick={(e) => { e.stopPropagation(); setToDelete(p); }}
                                            className="absolute right-1.5 top-1.5 rounded p-1 text-white/30 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                                            title="Delete setup"
                                        >
                                            <CloseIcon />
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* footer */}
                <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-4 py-3">
                    <button
                        type="button"
                        onClick={saveSetup}
                        className="inline-flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-2 text-sm font-medium text-white/80 hover:border-white/20 hover:text-white"
                    >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
                        Save setup
                    </button>
                    <div className="flex items-center gap-2">
                        <button type="button" onClick={() => { onApply(null); onClose(); }} className="rounded-md px-3 py-2 text-sm font-medium text-white/60 hover:text-white">
                            None
                        </button>
                        <button type="button" onClick={() => { onApply(draft); onClose(); }} className="rounded-md bg-primary px-5 py-2 text-sm font-bold text-black transition-colors hover:bg-primary/90">
                            Apply
                        </button>
                    </div>
                </div>
            </div>
            </div>
        </>
    );
}
