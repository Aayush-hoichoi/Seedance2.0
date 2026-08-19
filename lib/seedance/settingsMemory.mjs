// The prompt bar's SETTINGS, remembered across a reload: mode, model, aspect
// ratio, resolution, duration, seed, the audio/watermark toggles and the
// Image/Video switch (plus the image-side ratio/tier, which share the same
// pills). Nothing else — the prompt text and attached references are
// deliberately NOT stored, so a reload never re-attaches a file or re-fills a
// prompt the user has moved on from.
//
// Why: a generation that stalls leaves one reflex — refresh — and every choice
// reset to the defaults, so the setup had to be rebuilt from scratch before the
// user could even retry. The in-flight task already survives a reload
// (jobs.js); this is the same promise for the settings that produced it.
//
// pack/unpack are pure and dependency-injected (the valid catalogs are passed
// in, not imported) so they stay unit-testable under `node --test` without
// loading the ESM constants — same contract as options.mjs, which this builds
// on. load/save are the localStorage half and simply no-op on the server.

import { sanitizeOptions } from './options.mjs';

const KEY = 'seedance.settings.v1';

// Bumping this retires every stored entry (an entry of another version is
// ignored outright, never half-applied).
export const SETTINGS_VERSION = 1;

// The seed pill writes the raw <input> value, so a typed seed lives in state as
// a STRING ("1234"). Coerce rather than reject: falling back to -1 would
// silently re-randomise a seed the user pinned on purpose.
function coerceSeed(seed, fallback) {
    if (Number.isInteger(seed)) return seed;
    if (typeof seed === 'string' && seed.trim() !== '') {
        const n = Number(seed);
        if (Number.isFinite(n)) return Math.trunc(n);
    }
    return fallback;
}

export function packSettings({ modeId = null, mediaType = 'video', options = {} } = {}) {
    return {
        v: SETTINGS_VERSION,
        modeId,
        mediaType,
        // Whole options object: every field on it is a setting pill. The prompt
        // and references live in separate state and never reach this file.
        options: { ...options },
    };
}

// Validate a stored entry against the LIVE catalog and return the state to
// apply, or null when it can't be used. Each field falls back to its current
// default on its own, so one stale value (a retired model) never costs the
// user the rest of the setup.
export function unpackSettings(raw, {
    defaults,
    modeIds,
    modelIds, ratios, resolutions, modelSupports1080p, modelSupports4k,
    // Duration ceiling is PER MODEL (2.5 reaches 30s, the rest stop at 15).
    // Without this the sanitize falls back to the conservative 15s range and
    // a remembered 16-30s duration on 2.5 resets to the default on reload.
    modelDurationMax = null,
    imageModelIds, imageRatios, imageResolutions, imageDefaultModelId, imageStudioModelId,
}) {
    if (!raw || typeof raw !== 'object' || raw.v !== SETTINGS_VERSION) return null;

    const mediaType = raw.mediaType === 'image' ? 'image' : 'video';
    const isImage = mediaType === 'image';
    const src = raw.options && typeof raw.options === 'object' ? raw.options : {};

    // `model` is ONE field shared by both media types (the studio swaps it when
    // the Image/Video toggle flips), so it is resolved against the catalog of
    // the type the settings were saved in; the other type keeps its default.
    const video = sanitizeOptions(
        { ...src, seed: coerceSeed(src.seed, defaults.seed), model: isImage ? defaults.model : src.model },
        { defaults, modelIds, ratios, resolutions, modelSupports1080p, modelSupports4k, modelDurationMax },
    );
    // Cinematic Studio is a model in its own right — flag and model id must
    // agree, or the picker would read "Cinematic Studio" while sending a plain one.
    const imageStudio = isImage && src.imageStudio === true;
    const imageModel = imageStudio ? imageStudioModelId
        : imageModelIds.includes(src.model) ? src.model : imageDefaultModelId;

    return {
        modeId: modeIds.includes(raw.modeId) ? raw.modeId : null,
        mediaType,
        options: {
            ...video,
            model: isImage ? imageModel : video.model,
            imageRatio: imageRatios.includes(src.imageRatio) ? src.imageRatio : defaults.imageRatio,
            // Per-model and granted-tier clamping stays in the studio (only it
            // knows the live grants); membership in the tier list is all we
            // can check here.
            imageResolution: imageResolutions.includes(src.imageResolution) ? src.imageResolution : defaults.imageResolution,
            imageStudio,
        },
    };
}

/* ── storage (browser only; a failure costs the memory, never the session) ── */

export function loadSettings() {
    if (typeof window === 'undefined') return null;
    try {
        const raw = window.localStorage.getItem(KEY);
        const obj = raw ? JSON.parse(raw) : null;
        return obj && typeof obj === 'object' ? obj : null;
    } catch {
        return null;
    }
}

export function saveSettings(entry) {
    if (typeof window === 'undefined' || !entry) return;
    try {
        window.localStorage.setItem(KEY, JSON.stringify(entry));
    } catch {
        // Quota / private mode: settings just stop surviving reloads.
    }
}
