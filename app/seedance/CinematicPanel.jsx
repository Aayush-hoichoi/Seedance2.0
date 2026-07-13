'use client';

// Cinematic Cameras — centered modal for image mode. Pick a camera body, lens,
// focal length and aperture (via presets or the manual tiles); on Apply the
// active setup is lifted to the studio, where GPT-4o (style 'cinematic_camera')
// weaves it into the image prompt. All / Recommended / Saved tabs filter the
// preset list; custom setups persist per-device (lib/seedance/cameraPresets.js).

import { useEffect, useState } from 'react';
import {
    CAMERAS, LENSES, APERTURES, FOCAL_MIN, FOCAL_MAX,
    CINEMATIC_PRESETS, DEFAULT_SETUP, presetToSetup, sanitizeSetup, summarize, findCamera, findLens,
} from '../../lib/seedance/cinematic.mjs';
import { loadPresets, savePresets } from '../../lib/seedance/cameraPresets.js';

const TABS = [
    { id: 'all', label: 'All' },
    { id: 'recommended', label: 'Recommended' },
    { id: 'saved', label: 'Saved' },
];

const SELECT = 'w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-white text-center focus:border-primary focus:outline-none';

function Tile({ label, children }) {
    return (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-4 text-center">
            <div className="text-[10px] font-bold uppercase tracking-wider text-white/40">{label}</div>
            {children}
        </div>
    );
}

const CloseIcon = () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>);

export default function CinematicPanel({ open, setup, onApply, onClose }) {
    const [tab, setTab] = useState('all');
    const [draft, setDraft] = useState(DEFAULT_SETUP);
    const [saved, setSaved] = useState([]);

    // Each time the panel opens, seed the draft from the active setup (or the
    // default) and reload saved presets from localStorage.
    useEffect(() => {
        if (!open) return;
        setDraft(sanitizeSetup(setup) || DEFAULT_SETUP);
        setSaved(loadPresets());
        setTab('all');
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

    const removeSaved = (id) => {
        const next = saved.filter((p) => p.id !== id);
        savePresets(next);
        setSaved(next);
    };

    const presetList = tab === 'recommended'
        ? CINEMATIC_PRESETS.filter((p) => p.recommended)
        : tab === 'saved' ? saved : CINEMATIC_PRESETS;

    return (
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

                {/* editor tiles */}
                <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
                    <Tile label="Camera">
                        <div className="text-sm font-semibold text-white">{findCamera(draft.cameraId)?.name}</div>
                        <div className="text-[10px] uppercase tracking-wide text-white/35">{findCamera(draft.cameraId)?.type}</div>
                        <select className={SELECT} value={draft.cameraId} onChange={(e) => set({ cameraId: e.target.value })}>
                            {CAMERAS.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                    </Tile>
                    <Tile label="Lens">
                        <div className="text-sm font-semibold text-white">{findLens(draft.lensId)?.name}</div>
                        <div className="text-[10px] uppercase tracking-wide text-white/35">{findLens(draft.lensId)?.type}</div>
                        <select className={SELECT} value={draft.lensId} onChange={(e) => set({ lensId: e.target.value })}>
                            {LENSES.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                        </select>
                    </Tile>
                    <Tile label="Focal length">
                        <div className="text-2xl font-bold text-white">{draft.focalLength}<span className="text-sm font-normal text-white/50"> mm</span></div>
                        <input
                            type="range" min={FOCAL_MIN} max={FOCAL_MAX} value={draft.focalLength}
                            onChange={(e) => set({ focalLength: Number(e.target.value) })}
                            className="w-full accent-primary"
                        />
                    </Tile>
                    <Tile label="Aperture">
                        <div className="text-2xl font-bold text-white">f/{draft.aperture}</div>
                        <select className={SELECT} value={draft.aperture} onChange={(e) => set({ aperture: Number(e.target.value) })}>
                            {APERTURES.map((a) => <option key={a} value={a}>f/{a}</option>)}
                        </select>
                    </Tile>
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
                                            onClick={(e) => { e.stopPropagation(); removeSaved(p.id); }}
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
    );
}
