// Shared EXR options and the public BytePlus video-enhancement reference
// prices. This file is safe to import from both the browser and the server.

export const EXR_DEFAULT_OPTIONS = Object.freeze({
    tier: 'pro',
    resolution: '4k',
    fps: 24,
    bitDepth: 16,
    outputFormat: 'EXR',
});

export const EXR_TIERS = Object.freeze([
    { value: 'fast', label: 'Fast' },
    { value: 'standard', label: 'Standard' },
    { value: 'pro', label: 'Pro' },
]);

export const EXR_RESOLUTIONS = Object.freeze([
    { value: '720p', label: '720P' },
    { value: '1080p', label: '1080P' },
    { value: '2k', label: '2K' },
    { value: '4k', label: '4K' },
    { value: '6k', label: '6K' },
    { value: '8k', label: '8K' },
]);

export const EXR_FPS = Object.freeze([24, 30, 60, 120]);

// Prices are USD per processed output minute. The three values in each row
// are: up to 30 FPS, above 30 to 60 FPS, and above 60 to 120 FPS.
const PRICES = Object.freeze({
    fast: Object.freeze({
        '720p': [0.1033, 0.2066, 0.4132],
        '1080p': [0.2066, 0.4132, 0.8264],
        '2k': [0.4132, 0.8264, 1.6528],
        '4k': [0.8264, 1.6528, 3.3056],
        '6k': [1.6528, 3.3056, 6.6112],
        '8k': [3.3056, 6.6112, 13.2224],
    }),
    standard: Object.freeze({
        '720p': [0.2066, 0.4132, 0.8264],
        '1080p': [0.4132, 0.8264, 1.6528],
        '2k': [0.8264, 1.6528, 3.3056],
        '4k': [1.6528, 3.3056, 6.6112],
        '6k': [3.3056, 6.6112, 13.2224],
        '8k': [6.6112, 13.2224, 26.4448],
    }),
    pro: Object.freeze({
        '720p': [2.0661, 4.1322, 8.2644],
        '1080p': [4.1322, 8.2644, 16.5288],
        '2k': [8.2644, 16.5288, 33.0576],
        '4k': [16.5288, 33.0576, 66.1152],
        '6k': [33.0576, 66.1152, 132.2304],
        '8k': [66.1152, 132.2304, 264.4608],
    }),
});

const TIER_VALUES = new Set(EXR_TIERS.map((item) => item.value));
const RESOLUTION_VALUES = new Set(EXR_RESOLUTIONS.map((item) => item.value));
const FPS_VALUES = new Set(EXR_FPS);

function invalid(name, value) {
    const error = new Error(`Invalid EXR ${name}: ${String(value)}.`);
    error.status = 400;
    return error;
}

export function normalizeExrOptions(input = {}, { strict = false } = {}) {
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const fallback = EXR_DEFAULT_OPTIONS;
    const tier = String(raw.tier ?? fallback.tier).toLowerCase();
    const resolution = String(raw.resolution ?? fallback.resolution).toLowerCase();
    const fps = Number(raw.fps ?? fallback.fps);
    const bitDepth = Number(raw.bitDepth ?? raw.bit_depth ?? fallback.bitDepth);

    if (!TIER_VALUES.has(tier)) {
        if (strict) throw invalid('tier', tier);
        return { ...fallback };
    }
    if (!RESOLUTION_VALUES.has(resolution)) {
        if (strict) throw invalid('resolution', resolution);
        return { ...fallback };
    }
    if (!FPS_VALUES.has(fps)) {
        if (strict) throw invalid('frame rate', fps);
        return { ...fallback };
    }
    if (bitDepth !== 16) {
        if (strict) throw invalid('bit depth; only 16-bit is supported', bitDepth);
        return { ...fallback };
    }

    return { tier, resolution, fps, bitDepth: 16, outputFormat: 'EXR' };
}

export function pricePerExrMinute(options = {}) {
    const normalized = normalizeExrOptions(options);
    const fpsBand = normalized.fps <= 30 ? 0 : normalized.fps <= 60 ? 1 : 2;
    return PRICES[normalized.tier][normalized.resolution][fpsBand];
}

export function estimateExrCost(options = {}, durationSeconds) {
    const seconds = Number(durationSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return seconds / 60 * pricePerExrMinute(options);
}

export function bytePlusToolVersion(tier) {
    return tier === 'pro' ? 'professional' : tier;
}
