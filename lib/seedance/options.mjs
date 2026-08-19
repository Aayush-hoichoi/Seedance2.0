// Sanitize a stored generation-options snapshot before restoring it (e.g. on
// "Reuse" from history). A snapshot can be partial (server-merged cards only
// know model/resolution/duration/seed from ModelArk's task list), stale (a
// model that no longer offers 1080p), or absent (jobs created before options
// were persisted) — so every field is validated against the live catalog and
// falls back to the default when it doesn't fit.
//
// Pure + dependency-injected (the valid sets are passed in, not imported) so it
// stays unit-testable under `node --test` without loading the ESM constants.
// `.mjs` for the same reason. The duration ceiling is PER MODEL and injected
// like the resolution checks — 2.5 reaches 30s, every other tier stops at 15
// (live-probed, see constants.js). Inlining one range is what capped 2.5 at 15
// for its whole life. A caller that omits the check keeps the conservative
// range every model supports.
const DURATION_FLOOR = 4;
const DEFAULT_DURATION_MAX = 15;

function validDuration(d, max = DEFAULT_DURATION_MAX) {
    return d === -1 || (Number.isInteger(d) && d >= DURATION_FLOOR && d <= max);
}

export function sanitizeOptions(raw, { defaults, modelIds, ratios, resolutions, modelSupports1080p, modelSupports4k, modelDurationMax = null }) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const o = { ...defaults, ...src };

    const model = modelIds.includes(o.model) ? o.model : defaults.model;
    const ratio = ratios.includes(o.ratio) ? o.ratio : defaults.ratio;

    let resolution = resolutions.includes(o.resolution) ? o.resolution : defaults.resolution;
    // 1080p/4k are only valid on models that support them (per ModelArk, Fast
    // and Mini top out at 720p) — clamp down otherwise.
    if (resolution === '4k' && !modelSupports4k(model)) resolution = '720p';
    if (resolution === '1080p' && !modelSupports1080p(model)) resolution = '720p';

    const durationMax = modelDurationMax ? modelDurationMax(model) : DEFAULT_DURATION_MAX;
    const duration = validDuration(o.duration, durationMax) ? o.duration : defaults.duration;
    const generate_audio = typeof o.generate_audio === 'boolean' ? o.generate_audio : defaults.generate_audio;
    const watermark = typeof o.watermark === 'boolean' ? o.watermark : defaults.watermark;
    const seed = Number.isInteger(o.seed) ? o.seed : defaults.seed;

    return { model, ratio, resolution, duration, generate_audio, watermark, seed };
}
