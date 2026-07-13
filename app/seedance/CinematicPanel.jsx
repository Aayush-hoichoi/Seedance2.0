'use client';

// Cinematic Cameras — centered modal for image mode. Pick a camera body, lens,
// focal length and aperture (via presets or the manual tiles); on Apply the
// active setup is lifted to the studio, where GPT-4o (style 'cinematic_camera')
// weaves it into the image prompt. All / Recommended / Saved tabs filter the
// preset list; custom setups persist per-device (lib/seedance/cameraPresets.js).

import { useEffect, useRef, useState } from 'react';
import {
    CAMERAS, LENSES, APERTURES, FOCAL_MIN, FOCAL_MAX,
    CINEMATIC_PRESETS, DEFAULT_SETUP, presetToSetup, sanitizeSetup, summarize, findCamera, findLens,
} from '../../lib/seedance/cinematic.mjs';
import { loadPresets, savePresets } from '../../lib/seedance/cameraPresets.js';
import { ApertureIris, CameraGlyph, LensGlyph, FocalGlyph } from './cinematicIcons.jsx';

const TABS = [
    { id: 'all', label: 'All' },
    { id: 'recommended', label: 'Recommended' },
    { id: 'saved', label: 'Saved' },
];

// A horizontal, scrollable option picker (replaces the native dropdown): scroll
// through the choices and tap one. The active choice is highlighted and gets
// centred in view when it changes (e.g. after a preset is applied). Scrolls the
// strip only — never the modal — by setting scrollLeft directly.
function ScrollSelect({ items, getId, activeId, onPick, renderChip }) {
    const ref = useRef(null);
    useEffect(() => {
        const strip = ref.current;
        const el = strip?.querySelector('[data-active="true"]');
        if (strip && el) strip.scrollLeft = el.offsetLeft - (strip.clientWidth - el.clientWidth) / 2;
    }, [activeId]);
    return (
        <div ref={ref} className="relative flex w-full gap-1.5 overflow-x-auto scroll-smooth snap-x pb-1 custom-scrollbar">
            {items.map((it) => {
                const id = getId(it);
                const active = id === activeId;
                return (
                    <button
                        key={id}
                        type="button"
                        data-active={active}
                        onClick={() => onPick(id)}
                        className={`shrink-0 snap-center rounded-lg border px-2 py-1.5 transition-colors ${active ? 'border-primary/50 bg-primary/10' : 'border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.06]'}`}
                    >
                        {renderChip(it, active)}
                    </button>
                );
            })}
        </div>
    );
}

// A Higgsfield-style option tile: label on top, a big glyph in the middle, the
// current value name below, then the scroll-picker (or slider) control.
function Tile({ label, glyph, name, sub, children }) {
    return (
        <div className="flex flex-col items-center gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 pt-3 pb-3 text-center">
            <div className="text-[10px] font-bold uppercase tracking-wider text-white/40">{label}</div>
            <div className="flex h-16 items-center justify-center text-white/85">{glyph}</div>
            {name && <div className="text-sm font-semibold leading-tight text-white line-clamp-2 min-h-[2.25rem] flex items-center">{name}</div>}
            {sub && <div className="-mt-1 text-[10px] uppercase tracking-wide text-white/35">{sub}</div>}
            <div className="mt-1 w-full">{children}</div>
        </div>
    );
}

// The faded at-a-glance strip above the tiles (mirrors Higgsfield's preview row).
function PreviewStrip({ camera, lens, focal, aperture }) {
    return (
        <div className="mx-4 mb-1 mt-3 flex items-stretch justify-around gap-2 rounded-xl border border-white/[0.05] bg-white/[0.02] px-3 py-2 opacity-70">
            <div className="flex flex-1 items-center justify-center text-white/70"><CameraGlyph type={camera?.type} size={34} /></div>
            <div className="w-px bg-white/[0.06]" />
            <div className="flex flex-1 items-center justify-center text-white/70"><LensGlyph type={lens?.type} size={34} /></div>
            <div className="w-px bg-white/[0.06]" />
            <div className="flex flex-1 items-center justify-center text-lg font-bold tabular-nums text-white/60">{focal}<span className="ml-0.5 text-[10px] font-normal">mm</span></div>
            <div className="w-px bg-white/[0.06]" />
            <div className="flex flex-1 items-center justify-center text-white/70"><ApertureIris aperture={aperture} size={34} /></div>
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

                {/* at-a-glance preview strip */}
                <PreviewStrip
                    camera={findCamera(draft.cameraId)}
                    lens={findLens(draft.lensId)}
                    focal={draft.focalLength}
                    aperture={draft.aperture}
                />

                {/* editor tiles */}
                <div className="grid grid-cols-2 gap-3 px-4 pb-3 pt-2 sm:grid-cols-4">
                    <Tile label="Camera" glyph={<CameraGlyph type={findCamera(draft.cameraId)?.type} />} name={findCamera(draft.cameraId)?.name} sub={findCamera(draft.cameraId)?.type}>
                        <ScrollSelect
                            items={CAMERAS} getId={(c) => c.id} activeId={draft.cameraId} onPick={(id) => set({ cameraId: id })}
                            renderChip={(c, active) => (
                                <div className="flex w-12 flex-col items-center gap-0.5">
                                    <span className={active ? 'text-primary' : 'text-white/70'}><CameraGlyph type={c.type} size={22} /></span>
                                    <span className="w-full truncate text-center text-[9px] leading-tight text-white/70">{c.name}</span>
                                </div>
                            )}
                        />
                    </Tile>
                    <Tile label="Lens" glyph={<LensGlyph type={findLens(draft.lensId)?.type} />} name={findLens(draft.lensId)?.name} sub={findLens(draft.lensId)?.type}>
                        <ScrollSelect
                            items={LENSES} getId={(l) => l.id} activeId={draft.lensId} onPick={(id) => set({ lensId: id })}
                            renderChip={(l, active) => (
                                <div className="flex w-12 flex-col items-center gap-0.5">
                                    <span className={active ? 'text-primary' : 'text-white/70'}><LensGlyph type={l.type} size={22} /></span>
                                    <span className="w-full truncate text-center text-[9px] leading-tight text-white/70">{l.name}</span>
                                </div>
                            )}
                        />
                    </Tile>
                    <Tile label="Focal length" glyph={<FocalGlyph mm={draft.focalLength} />} name={<span>{draft.focalLength}<span className="text-sm font-normal text-white/50"> mm</span></span>}>
                        <input
                            type="range" min={FOCAL_MIN} max={FOCAL_MAX} value={draft.focalLength}
                            onChange={(e) => set({ focalLength: Number(e.target.value) })}
                            className="w-full accent-primary"
                        />
                    </Tile>
                    <Tile label="Aperture" glyph={<ApertureIris aperture={draft.aperture} />} name={<span>f/{draft.aperture}</span>}>
                        <ScrollSelect
                            items={APERTURES} getId={(a) => a} activeId={draft.aperture} onPick={(a) => set({ aperture: a })}
                            renderChip={(a, active) => (
                                <span className={`block w-8 text-center text-xs font-bold tabular-nums ${active ? 'text-primary' : 'text-white/80'}`}>f/{a}</span>
                            )}
                        />
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
