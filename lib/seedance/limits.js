// BytePlus ModelArk Seedance 2.0 — input limits, transcribed verbatim from the
// official API reference (docs.byteplus.com/en/docs/ModelArk/1520757) and the
// private-asset doc (/2333565). Single source of truth: validators below and the
// UI both read these, so when BytePlus revises a limit you change it in one place.

export const REQUEST_MAX_BYTES = 64 * 1024 * 1024; // total request body must not exceed 64 MB

export const IMAGE_LIMITS = {
    // jpeg/png/webp/bmp/tiff/gif always; heic/heif on Seedance 1.5 Pro & 2.0.
    formats: ['jpeg', 'jpg', 'png', 'webp', 'bmp', 'tiff', 'tif', 'gif', 'heic', 'heif'],
    maxBytes: 30 * 1024 * 1024,
    minDim: 300,
    maxDim: 6000,
    minAspect: 0.4,
    maxAspect: 2.5,
};

export const VIDEO_LIMITS = {
    formats: ['mp4', 'mov'], // encodings: H.264/AVC, H.265/HEVC; embedded audio AAC/MP3
    maxBytes: 50 * 1024 * 1024,
    minDim: 300,
    maxDim: 6000,
    minTotalPx: 409600, // 640 × 640
    maxTotalPx: 2086876, // 2206 × 946
    minAspect: 0.4,
    maxAspect: 2.5,
    minFps: 24,
    maxFps: 60,
    minDurationSec: 2,
    maxDurationSec: 15,
    maxTotalDurationSec: 15, // across all reference videos combined
    maxCount: 3,
};

export const AUDIO_LIMITS = {
    formats: ['wav', 'mp3'],
    maxBytes: 15 * 1024 * 1024,
    minDurationSec: 2,
    maxDurationSec: 15,
    maxTotalDurationSec: 15, // across all reference audio combined
    maxCount: 3,
};

export const REFERENCE_IMAGE_MAX = 9; // multimodal reference: 0–9 images

const LIMITS_BY_KIND = { image: IMAGE_LIMITS, video: VIDEO_LIMITS, audio: AUDIO_LIMITS };

export function limitsFor(kind) {
    const l = LIMITS_BY_KIND[kind];
    if (!l) throw new Error(`No limits defined for media kind: ${kind}`);
    return l;
}

// ── formatting helpers ───────────────────────────────────────────────────────
export function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

export function extensionOf(name = '') {
    const m = /\.([a-z0-9]+)$/i.exec(name.trim());
    return m ? m[1].toLowerCase() : '';
}

// ── pure validators (return an error string, or null when valid) ─────────────

// File size + format. Works from a File/Blob-like { name, size, type }.
export function validateFileBasics(kind, file) {
    const limits = limitsFor(kind);
    const ext = extensionOf(file.name);
    const okByExt = ext && limits.formats.includes(ext);
    const okByMime = typeof file.type === 'string' && file.type.startsWith(`${kind}/`);
    if (!okByExt && !okByMime) {
        return `Unsupported ${kind} format${ext ? ` (.${ext})` : ''}. Allowed: ${limits.formats.join(', ')}.`;
    }
    if (typeof file.size === 'number' && file.size > limits.maxBytes) {
        return `${file.name || 'File'} is ${formatBytes(file.size)} — over the ${formatBytes(limits.maxBytes)} ${kind} limit.`;
    }
    return null;
}

export function validateImageDimensions(width, height) {
    const { minDim, maxDim, minAspect, maxAspect } = IMAGE_LIMITS;
    if (width < minDim || height < minDim) return `Image is ${width}×${height}px — minimum is ${minDim}×${minDim}px.`;
    if (width > maxDim || height > maxDim) return `Image is ${width}×${height}px — maximum is ${maxDim}×${maxDim}px.`;
    const aspect = width / height;
    if (aspect < minAspect || aspect > maxAspect) {
        return `Image aspect ratio ${aspect.toFixed(2)} is outside the allowed ${minAspect}–${maxAspect} range.`;
    }
    return null;
}

export function validateVideoMetadata({ width, height, durationSec, fps }) {
    const L = VIDEO_LIMITS;
    if (width && height) {
        if (width < L.minDim || height < L.minDim || width > L.maxDim || height > L.maxDim) {
            return `Video is ${width}×${height}px — each side must be ${L.minDim}–${L.maxDim}px.`;
        }
        const totalPx = width * height;
        if (totalPx < L.minTotalPx || totalPx > L.maxTotalPx) {
            return `Video has ${totalPx.toLocaleString()} total pixels — must be between ${L.minTotalPx.toLocaleString()} and ${L.maxTotalPx.toLocaleString()}.`;
        }
        const aspect = width / height;
        if (aspect < L.minAspect || aspect > L.maxAspect) {
            return `Video aspect ratio ${aspect.toFixed(2)} is outside the allowed ${L.minAspect}–${L.maxAspect} range.`;
        }
    }
    if (durationSec != null && (durationSec < L.minDurationSec || durationSec > L.maxDurationSec)) {
        return `Video is ${durationSec.toFixed(1)}s — each reference video must be ${L.minDurationSec}–${L.maxDurationSec}s.`;
    }
    if (fps != null) {
        // Round before comparing: real-world rates like 23.976 (NTSC film) must
        // pass the [24, 60] check, and our sampling is approximate anyway.
        const r = Math.round(fps);
        if (r < L.minFps || r > L.maxFps) {
            return `Video is ${r} fps — must be ${L.minFps}–${L.maxFps} fps.`;
        }
    }
    return null;
}

export function validateAudioMetadata({ durationSec }) {
    const L = AUDIO_LIMITS;
    if (durationSec != null && (durationSec < L.minDurationSec || durationSec > L.maxDurationSec)) {
        return `Audio is ${durationSec.toFixed(1)}s — each reference audio must be ${L.minDurationSec}–${L.maxDurationSec}s.`;
    }
    return null;
}

// Aggregate rules across a resolved media list (durations summed per kind, counts).
export function validateAggregate(mediaItems) {
    const videos = mediaItems.filter((m) => m.kind === 'video');
    const audios = mediaItems.filter((m) => m.kind === 'audio');

    if (videos.length > VIDEO_LIMITS.maxCount) return `Too many reference videos (${videos.length}); max is ${VIDEO_LIMITS.maxCount}.`;
    if (audios.length > AUDIO_LIMITS.maxCount) return `Too many reference audio files (${audios.length}); max is ${AUDIO_LIMITS.maxCount}.`;

    const sum = (items) => items.reduce((t, m) => t + (m.durationSec || 0), 0);
    const vTotal = sum(videos);
    if (vTotal > VIDEO_LIMITS.maxTotalDurationSec) {
        return `Total reference-video duration is ${vTotal.toFixed(1)}s — combined must not exceed ${VIDEO_LIMITS.maxTotalDurationSec}s.`;
    }
    const aTotal = sum(audios);
    if (aTotal > AUDIO_LIMITS.maxTotalDurationSec) {
        return `Total reference-audio duration is ${aTotal.toFixed(1)}s — combined must not exceed ${AUDIO_LIMITS.maxTotalDurationSec}s.`;
    }
    return null;
}

// Rough guard against the 64 MB request-body cap for base64-inlined (non-asset)
// media. Base64 inflates bytes by ~4/3; asset:// and remote URLs cost ~0.
export function estimateRequestBytes(mediaItems) {
    return mediaItems.reduce((total, m) => {
        if (typeof m.url === 'string' && m.url.startsWith('data:')) {
            const comma = m.url.indexOf(',');
            if (comma !== -1) return total + Math.floor((m.url.length - comma - 1) * 0.75);
        }
        return total;
    }, 0);
}

export function validateRequestSize(mediaItems) {
    const bytes = estimateRequestBytes(mediaItems);
    if (bytes > REQUEST_MAX_BYTES) {
        return `Inlined inputs total ~${formatBytes(bytes)}, over the ${formatBytes(REQUEST_MAX_BYTES)} request limit. Use library assets (asset://) instead of uploading large files.`;
    }
    return null;
}
