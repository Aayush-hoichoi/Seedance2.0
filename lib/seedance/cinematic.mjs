// Cinematic Cameras — catalog + pure helpers for image generation.
//
// The user picks a camera body, lens, focal length and aperture (via a preset
// or the manual controls); those values are woven into an enhancer system prompt
// (POST /api/openai/enhance, style 'cinematic_camera') which returns an
// optimized, photographic prompt for the Nano Banana image model. Everything
// here is pure data + pure functions — no React, no I/O.

export const CAMERAS = [
    { id: 'film16', name: 'Classic 16mm Film', type: 'film' },
    { id: 'film35', name: 'Vintage 35mm Film', type: 'film' },
    { id: 'largeformat', name: 'Large Format Film', type: 'film' },
    { id: 's35digital', name: 'Studio Digital S35', type: 'digital' },
    { id: 'fullframe', name: 'Full-Frame Digital', type: 'digital' },
    { id: 'cinema8k', name: 'Cinema Digital 8K', type: 'digital' },
];

export const LENSES = [
    { id: 'classicAnamorphic', name: 'Classic Anamorphic', type: 'anamorphic' },
    { id: 'modernAnamorphic', name: 'Modern Anamorphic', type: 'anamorphic' },
    { id: 'modernPrime', name: 'Premium Modern Prime', type: 'spherical' },
    { id: 'vintagePrime', name: 'Vintage Spherical Prime', type: 'spherical' },
    { id: 'macroPrime', name: 'Macro Prime', type: 'spherical' },
];

export const FOCAL_MIN = 14;
export const FOCAL_MAX = 200;
export const FOCAL_DEFAULT = 50;

// Common cine focal lengths (mm) for the focal-length reel. sanitizeSetup still
// accepts any value in [FOCAL_MIN, FOCAL_MAX]; these are just the reel stops.
export const FOCAL_STOPS = [14, 16, 18, 21, 24, 28, 32, 35, 40, 50, 65, 75, 85, 100, 120, 135, 150, 180, 200];

// Standard f-stops, widest → smallest.
export const APERTURES = [1.4, 1.8, 2, 2.8, 4, 5.6, 8, 11, 16, 22];
export const APERTURE_DEFAULT = 4;

// Built-in setups. `recommended` ones surface in the panel's Recommended tab.
export const CINEMATIC_PRESETS = [
    { id: 'classic16', name: 'Classic 16mm Film', cameraId: 'film16', lensId: 'classicAnamorphic', focalLength: 50, aperture: 11, recommended: true },
    { id: 'studioS35', name: 'Studio Digital S35', cameraId: 's35digital', lensId: 'modernPrime', focalLength: 35, aperture: 4, recommended: true },
    { id: 'portraitPrime', name: 'Portrait Prime', cameraId: 'fullframe', lensId: 'modernPrime', focalLength: 85, aperture: 1.8, recommended: true },
    { id: 'wideEstablish', name: 'Wide Establishing', cameraId: 'cinema8k', lensId: 'vintagePrime', focalLength: 24, aperture: 8, recommended: true },
    { id: 'vintage35', name: 'Vintage 35mm', cameraId: 'film35', lensId: 'vintagePrime', focalLength: 40, aperture: 2.8 },
    { id: 'macroDetail', name: 'Macro Detail', cameraId: 'fullframe', lensId: 'macroPrime', focalLength: 100, aperture: 5.6 },
];

// The default active setup when a user first opens the panel.
export const DEFAULT_SETUP = presetToSetup(CINEMATIC_PRESETS[0]);

export function findCamera(id) { return CAMERAS.find((c) => c.id === id) || null; }
export function findLens(id) { return LENSES.find((l) => l.id === id) || null; }
export function findPreset(id) { return CINEMATIC_PRESETS.find((p) => p.id === id) || null; }

// A preset (built-in or saved) → an active setup object.
export function presetToSetup(p) {
    return { presetId: p.id, cameraId: p.cameraId, lensId: p.lensId, focalLength: p.focalLength, aperture: p.aperture };
}

function clampFocal(n) {
    if (!Number.isFinite(n)) return FOCAL_DEFAULT;
    return Math.min(FOCAL_MAX, Math.max(FOCAL_MIN, Math.round(n)));
}

// Coerce an untrusted setup (restored from a saved preset / snapshot) to valid
// catalog values — unknown ids fall back to the default so the UI never breaks.
export function sanitizeSetup(s) {
    if (!s || typeof s !== 'object') return null;
    return {
        presetId: typeof s.presetId === 'string' ? s.presetId : null,
        cameraId: findCamera(s.cameraId) ? s.cameraId : DEFAULT_SETUP.cameraId,
        lensId: findLens(s.lensId) ? s.lensId : DEFAULT_SETUP.lensId,
        focalLength: clampFocal(Number(s.focalLength)),
        aperture: APERTURES.includes(Number(s.aperture)) ? Number(s.aperture) : APERTURE_DEFAULT,
    };
}

// One-line chip summary, e.g. "Classic 16mm Film · 50mm · f/11".
export function summarize(setup) {
    if (!setup) return null;
    const cam = findCamera(setup.cameraId);
    return [cam?.name, `${setup.focalLength}mm`, `f/${setup.aperture}`].filter(Boolean).join(' · ');
}

// The `camera` payload sent to the enhancer — human-labeled so the model reads it as
// photographic direction. Returns null when no setup is active (plain gen).
export function cinematicToPayload(setup) {
    if (!setup) return null;
    const cam = findCamera(setup.cameraId);
    const lens = findLens(setup.lensId);
    return {
        camera: cam ? `${cam.name} (${cam.type})` : null,
        lens: lens ? `${lens.name} (${lens.type})` : null,
        focalLength: `${setup.focalLength}mm`,
        aperture: `f/${setup.aperture}`,
    };
}
