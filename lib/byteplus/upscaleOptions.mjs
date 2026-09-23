// Upscale tool options → BytePlus AI MediaKit enhance-video request fields.
// Spec: docs.byteplus.com/en/docs/byteplus-vod/ai-mediakit-create-a-video-enhancement-task
// Safe to import from both the browser (form + estimate) and the server (strict
// validation before anything is queued).

export const UPSCALE_VERSIONS = Object.freeze([
    { value: 'standard', label: 'Standard', hint: '10+ algorithms · ~6–10 min per video minute' },
    { value: 'professional', label: 'Professional', hint: '30+ algorithms · 25–60 min per video minute · 10× price' },
]);
export const UPSCALE_SCENES = Object.freeze([
    { value: 'common', label: 'General' },
    { value: 'aigc', label: 'AI-generated' },
    { value: 'short_series', label: 'Short drama' },
    { value: 'ugc', label: 'UGC short video' },
    { value: 'old_film', label: 'Old film restoration' },
]);
export const UPSCALE_STYLES = Object.freeze([
    { value: 'hd', label: 'HD — sharper' },
    { value: 'natural', label: 'Natural — fewer artifacts' },
]);
export const UPSCALE_RESOLUTIONS = Object.freeze(['240p', '360p', '480p', '540p', '720p', '1080p', '2k', '4k', '6k', '8k']);
export const UPSCALE_BITRATE_LEVELS = Object.freeze(['low', 'medium', 'high']);
// Professional only. Valid codec ↔ bit depth pairs and their container. The
// exr codec is left to the separate EXR tool.
export const UPSCALE_CODECS = Object.freeze([
    { value: 'h264', label: 'H.264', depths: [8], container: 'mp4' },
    { value: 'h265', label: 'H.265 (HEVC)', depths: [8, 10, 12], container: 'mp4' },
    { value: 'prores', label: 'Apple ProRes 422', depths: [10], container: 'mov' },
    { value: 'ffv1', label: 'FFV1 (lossless)', depths: [16], container: 'mov' },
]);
export const UPSCALE_LIMITS = Object.freeze({
    shortSideMin: 128, shortSideMax: 4320,
    fpsMin: 15, fpsMax: 120,
    kbpsMin: 10, kbpsMax: 150000,
    maxInputLongSide: 2560, maxInputShortSide: 1440, // "input up to 2K"
    maxSeconds16Bit: 40,
    maxInputBytes: 10 * 1024 ** 3, // recommended, not enforced by BytePlus
});
// Input container formats BytePlus accepts. Checked by extension: browsers
// report an empty MIME type for several of these (mkv, ts, flv).
export const UPSCALE_INPUT_EXTENSIONS = Object.freeze(['mp4', 'flv', 'ts', 'avi', 'mov', 'wmv', 'mkv']);
export const isUpscaleInputName = (name = '') => UPSCALE_INPUT_EXTENSIONS.includes(String(name).split('.').pop().toLowerCase());

export const UPSCALE_DEFAULTS = Object.freeze({
    version: 'standard',
    scene: 'aigc',
    style: 'hd',
    resolutionMode: 'preset', // preset | limit | source
    resolution: '1080p',
    shortSide: 1080,
    fpsMode: 'source',        // source | custom
    fps: 30,
    bitrateMode: 'level',     // level | kbps
    bitrateLevel: 'medium',
    kbps: 8000,
    bitDepth: 8,
    codec: 'h264',
});

const LOSSLESS = new Set(['prores', 'ffv1']); // codecs where bitrate is ignored

function invalid(message) {
    return Object.assign(new Error(message), { status: 400 });
}

const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
// fps is a Number in the spec — allow 23.976 / 29.97, three decimals max.
const fpsIn = (v, min, max) => Number.isFinite(v) && v >= min && v <= max && Math.round(v * 1000) === v * 1000;

// Bitrate settings only apply to lossy codecs below 16-bit.
export function bitrateApplies(o) {
    return !(o.version === 'professional' && (LOSSLESS.has(o.codec) || o.bitDepth === 16));
}

export function containerFor(o) {
    if (o.version !== 'professional') return 'mp4';
    return UPSCALE_CODECS.find((c) => c.value === o.codec)?.container || 'mp4';
}

// → { options, body } where body is exactly the provider fields (minus video_url).
// Throws a 400 error naming the first bad field.
export function buildUpscaleRequest(raw = {}, { sourceSeconds = null } = {}) {
    const o = { ...UPSCALE_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
    const L = UPSCALE_LIMITS;
    if (!UPSCALE_VERSIONS.some((x) => x.value === o.version)) throw invalid(`Invalid version: ${o.version}.`);
    if (!UPSCALE_SCENES.some((x) => x.value === o.scene)) throw invalid(`Invalid scene: ${o.scene}.`);
    if (!UPSCALE_STYLES.some((x) => x.value === o.style)) throw invalid(`Invalid style: ${o.style}.`);

    const body = { tool_version: o.version, scene: o.scene, enhance_style: o.style };

    if (o.resolutionMode === 'preset') {
        if (!UPSCALE_RESOLUTIONS.includes(o.resolution)) throw invalid(`Invalid resolution: ${o.resolution}.`);
        body.resolution = o.resolution;
    } else if (o.resolutionMode === 'limit') {
        o.shortSide = Number(o.shortSide);
        if (!intIn(o.shortSide, L.shortSideMin, L.shortSideMax)) throw invalid(`Short side must be a whole number from ${L.shortSideMin} to ${L.shortSideMax} px.`);
        body.resolution_limit = o.shortSide;
    } else if (o.resolutionMode !== 'source') throw invalid(`Invalid resolution mode: ${o.resolutionMode}.`);

    if (o.fpsMode === 'custom') {
        o.fps = Number(o.fps);
        if (!fpsIn(o.fps, L.fpsMin, L.fpsMax)) throw invalid(`Frame rate must be ${L.fpsMin}–${L.fpsMax} (up to 3 decimals, e.g. 23.976).`);
        body.fps = o.fps;
    } else if (o.fpsMode !== 'source') throw invalid(`Invalid frame-rate mode: ${o.fpsMode}.`);

    if (o.version === 'professional') {
        o.bitDepth = Number(o.bitDepth);
        const codec = UPSCALE_CODECS.find((c) => c.value === o.codec);
        if (!codec) throw invalid(`Invalid codec: ${o.codec}.`);
        if (!codec.depths.includes(o.bitDepth)) throw invalid(`${codec.label} supports ${codec.depths.join('/')}-bit, not ${o.bitDepth}-bit.`);
        const secs = Number(sourceSeconds);
        if (o.bitDepth === 16 && Number.isFinite(secs) && secs > L.maxSeconds16Bit) throw invalid(`16-bit output needs a source of ${L.maxSeconds16Bit}s or less.`);
        body.bit_depth = o.bitDepth;
        body.codec = o.codec;
    }

    if (bitrateApplies(o)) {
        if (o.bitrateMode === 'kbps') {
            o.kbps = Number(o.kbps);
            if (!intIn(o.kbps, L.kbpsMin, L.kbpsMax)) throw invalid(`Bitrate must be a whole number from ${L.kbpsMin} to ${L.kbpsMax} kbps.`);
            body.bitrate = o.kbps;
        } else if (o.bitrateMode === 'level') {
            if (!UPSCALE_BITRATE_LEVELS.includes(o.bitrateLevel)) throw invalid(`Invalid bitrate level: ${o.bitrateLevel}.`);
            body.bitrate_level = o.bitrateLevel;
        } else throw invalid(`Invalid bitrate mode: ${o.bitrateMode}.`);
    }

    return { options: o, body };
}

/* ── pricing ────────────────────────────────────────────────────────────── */

// USD per output minute at ≤30fps before the version coefficient (Standard ×2,
// Professional ×20 — BytePlus pricing page). The fps bands double the price:
// (30,60] ×2, (60,120] ×4.
// ponytail: below 720p is billed at the 720p rate (no published lower band);
// correct it here if the BytePlus invoice disagrees.
const BASE_PER_MIN = Object.freeze({ '720p': 0.1033, '1080p': 0.2066, '2k': 0.4132, '4k': 0.8264, '6k': 1.6528, '8k': 3.3056 });
const COEFFICIENT = Object.freeze({ standard: 2, professional: 20 });

function bandForShortSide(px) {
    if (px <= 720) return '720p';
    if (px <= 1080) return '1080p';
    if (px <= 1440) return '2k';
    if (px <= 2160) return '4k';
    if (px <= 3240) return '6k';
    return '8k';
}
const PRESET_SHORT_SIDE = { '240p': 240, '360p': 360, '480p': 480, '540p': 540, '720p': 720, '1080p': 1080, '2k': 1440, '4k': 2160, '6k': 3240, '8k': 4320 };

// source: { seconds, width, height } read from the picked file. Returns null
// when the estimate cannot be made (no duration yet, or bad options).
export function estimateUpscaleCost(raw, source = {}) {
    const seconds = Number(source.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    let o;
    try { ({ options: o } = buildUpscaleRequest(raw)); } catch { return null; }
    const srcShort = Math.min(Number(source.width) || 0, Number(source.height) || 0) || 1080;
    const shortSide = o.resolutionMode === 'preset' ? PRESET_SHORT_SIDE[o.resolution]
        : o.resolutionMode === 'limit' ? o.shortSide : srcShort;
    const fps = o.fpsMode === 'custom' ? o.fps : 30; // source fps unknown in the browser; assume ≤30
    const fpsFactor = fps <= 30 ? 1 : fps <= 60 ? 2 : 4;
    return (seconds / 60) * BASE_PER_MIN[bandForShortSide(shortSide)] * COEFFICIENT[o.version] * fpsFactor;
}

// Minimum wall-clock minutes regardless of clip length: BytePlus queueing and
// start-up dominate short clips, and 16-bit tasks run one at a time.
// ponytail: calibrated from our own runs (2026-09-23: 4–10s Pro 4K 16-bit took
// 35–58 min; a 4s Pro 4K 8-bit took >10 min) — retune as more jobs finish.
export const UPSCALE_MIN_WAIT_MIN = Object.freeze({ standard: 5, professional: 15, sixteenBit: 35 });

// Rough wall-clock wait: the BytePlus real-time-factor table, floored by the
// fixed overhead above.
export function estimateUpscaleMinutes(raw, seconds) {
    const s = Number(seconds);
    if (!Number.isFinite(s) || s <= 0) return null;
    let o;
    try { ({ options: o } = buildUpscaleRequest(raw)); } catch { return null; }
    let rtf;
    if (o.version === 'standard') rtf = s <= 20 ? 22 : 8;
    else {
        const short = o.resolutionMode === 'preset' ? PRESET_SHORT_SIDE[o.resolution] : o.resolutionMode === 'limit' ? o.shortSide : 1080;
        rtf = short <= 1080 ? 25 : short <= 1440 ? 40 : 60;
    }
    const floor = o.version === 'professional' && o.bitDepth === 16 ? UPSCALE_MIN_WAIT_MIN.sixteenBit
        : UPSCALE_MIN_WAIT_MIN[o.version];
    return Math.max(floor, Math.round((s * rtf) / 60));
}

// Elapsed vs estimate for a running job → { elapsed, est, over } in minutes.
export function upscaleTiming(job, now = Date.now()) {
    if (!job?.createdAt) return null;
    const elapsed = Math.max(0, Math.floor((now - new Date(job.createdAt).getTime()) / 60000));
    const est = Number(job.waitMin) || null;
    return { elapsed, est, over: est != null && elapsed >= est };
}

// Input rule from the spec: source resolution up to 2K.
export function sourceTooLarge(width, height) {
    const w = Number(width), h = Number(height);
    if (!w || !h) return false;
    return Math.max(w, h) > UPSCALE_LIMITS.maxInputLongSide || Math.min(w, h) > UPSCALE_LIMITS.maxInputShortSide;
}

/* ── reference tables (docs) ─────────────────────────────────────────────── */

// Target bitrate in Mbps for bitrate_level, by output resolution and fps band
// ([15,30], (30,60], (60,120]). Actual output lands at 0.8–1.5× this. The docs
// publish no 6K row.
const BITRATE_MBPS = Object.freeze({
    '240p': [[0.3, 0.45, 0.6], [0.65, 0.9, 1.2], [1.5, 2.2, 2.8]],
    '360p': [[0.6, 0.85, 1.2], [1, 1.5, 2], [1.7, 2.5, 3.2]],
    '480p': [[1.2, 1.8, 2.3], [2.1, 3, 3.9], [3.5, 5, 6.5]],
    '540p': [[1.7, 2.5, 3.2], [2.8, 4, 5.2], [4.2, 6, 7.8]],
    '720p': [[2.8, 4, 5.2], [5.6, 8, 10], [8.4, 12, 15]],
    '1080p': [[5, 7, 9], [10, 14, 18], [15, 22, 28]],
    '2k': [[10, 15, 20], [17, 24, 32], [28, 40, 52]],
    '4k': [[21, 30, 39], [32, 45, 58], [53, 75, 100]],
    '8k': [[42, 60, 78], [63, 90, 120], [84, 120, 150]],
});

// → Mbps for a given level, or null when unknown (non-preset resolution,
// source fps, 6K).
export function targetBitrateMbps(o, level = o?.bitrateLevel) {
    if (o?.resolutionMode !== 'preset' || o?.fpsMode !== 'custom') return null;
    const row = BITRATE_MBPS[o.resolution];
    const li = UPSCALE_BITRATE_LEVELS.indexOf(level);
    if (!row || li < 0) return null;
    const fps = Number(o.fps);
    return row[fps <= 30 ? 0 : fps <= 60 ? 1 : 2][li];
}

// Professional runs one of three tiers picked from the output resolution
// (old_film uses its own restoration template).
export function proTier(o) {
    if (o?.version !== 'professional') return null;
    if (o.scene === 'old_film') return 'Film restoration template';
    const short = o.resolutionMode === 'preset' ? PRESET_SHORT_SIDE[o.resolution] : o.resolutionMode === 'limit' ? Number(o.shortSide) : null;
    if (short == null) return 'Medium / Premium / Ultimate (by output resolution)';
    return short <= 1080 ? 'Medium (≤1080p)' : short <= 1440 ? 'Premium (2K)' : 'Ultimate (4K+)';
}

// One-line description of a job's settings (history rail + detail view).
export function upscaleSummary(o = {}) {
    const res = o.resolutionMode === 'limit' ? `${o.shortSide}px short side`
        : o.resolutionMode === 'source' ? 'source res' : String(o.resolution || '').toUpperCase();
    const fps = o.fpsMode === 'custom' ? `${o.fps}fps` : 'source fps';
    const pro = o.version === 'professional' ? ` · ${o.codec} ${o.bitDepth}-bit` : '';
    return `${o.version === 'professional' ? 'Pro' : 'Standard'} · ${res} · ${fps}${pro}`;
}
