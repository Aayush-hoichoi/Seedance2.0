// Sanitize a stored generation-options snapshot before restoring it (e.g. on
// "Reuse" from history). A snapshot can be partial (server-merged cards only
// know model/resolution/duration/seed from ModelArk's task list), stale (a
// model that no longer offers 1080p), or absent (jobs created before options
// were persisted) — so every field is validated against the live catalog and
// falls back to the default when it doesn't fit.
//
// Pure + dependency-injected (the valid sets are passed in, not imported) so it
// stays unit-testable under `node --test` without loading the ESM constants.
// `.mjs` for the same reason. Seedance duration rule (integer [4,15] or -1) is
// stable, so it's inlined.

function validDuration(d) {
    return d === -1 || (Number.isInteger(d) && d >= 4 && d <= 15);
}

export function sanitizeOptions(raw, { defaults, modelIds, ratios, resolutions, modelSupports1080p }) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const o = { ...defaults, ...src };

    const model = modelIds.includes(o.model) ? o.model : defaults.model;
    const ratio = ratios.includes(o.ratio) ? o.ratio : defaults.ratio;

    let resolution = resolutions.includes(o.resolution) ? o.resolution : defaults.resolution;
    // 1080p is only valid on models that support it — clamp down otherwise.
    if (resolution === '1080p' && !modelSupports1080p(model)) resolution = '720p';

    const duration = validDuration(o.duration) ? o.duration : defaults.duration;
    const generate_audio = typeof o.generate_audio === 'boolean' ? o.generate_audio : defaults.generate_audio;
    const watermark = typeof o.watermark === 'boolean' ? o.watermark : defaults.watermark;
    const seed = Number.isInteger(o.seed) ? o.seed : defaults.seed;

    return { model, ratio, resolution, duration, generate_audio, watermark, seed };
}
