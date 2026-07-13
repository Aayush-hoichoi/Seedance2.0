// Trust-boundary validation for image (Nano Banana / Gemini) generation
// requests. The studio client already caps refs at 3 and downscales to ~1024px
// JPEG, but /api/generations is a public authenticated endpoint — a direct
// caller can send anything. This sanitizes what actually reaches Gemini and the
// cost estimator, so a bad request fails fast with a clear message instead of
// burning a batch slot + a failure billing event on a guaranteed-to-fail call.

const MAX_PROMPT = 5000;          // characters
const MAX_REF_IMAGES = 3;         // inline reference images per request
const MAX_TOTAL_B64 = 4 * 1024 * 1024; // ~4MB base64 total, under the platform body cap
const MAX_IMAGE_COUNT = 4;        // images requested per job (cost driver)
const DATA_URL_RE = /^data:([^;]+);base64,/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// Gemini imageConfig whitelists — anything off-list is dropped (not errored) so
// the model falls back to its default rather than rejecting the whole request.
const ASPECT_RATIOS = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
const IMAGE_SIZES = new Set(['1K', '2K', '4K']);

// Returns { error } OR { request, imageCount }. `request` is the sanitized body
// to persist/forward (prompt always present; parts normalized when supplied).
export function sanitizeImageRequest(request, options = {}) {
    if (!request || typeof request !== 'object') return { error: 'A prompt is required.' };
    const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
    if (!prompt) return { error: 'A prompt is required.' };
    if (prompt.length > MAX_PROMPT) return { error: `Prompt is too long (max ${MAX_PROMPT} characters).` };

    let parts = null;
    if (request.parts != null) {
        if (!Array.isArray(request.parts)) return { error: 'Reference images are malformed.' };
        const clean = [];
        let refCount = 0;
        let totalB64 = 0;
        let hasText = false;
        for (const p of request.parts) {
            if (!p || typeof p !== 'object') continue;
            if (typeof p.text === 'string') { clean.push({ text: p.text }); hasText = true; continue; }
            const inline = p.inlineData;
            if (!inline || typeof inline.data !== 'string') return { error: 'A reference image is malformed.' };
            let mimeType = typeof inline.mimeType === 'string' ? inline.mimeType : '';
            let data = inline.data;
            const m = DATA_URL_RE.exec(data);
            if (m) { mimeType = mimeType || m[1]; data = data.slice(m[0].length); } // strip an accidental data: prefix
            if (!/^image\//.test(mimeType)) return { error: 'Reference files must be images.' };
            if (!BASE64_RE.test(data)) return { error: 'A reference image is not valid base64.' };
            refCount += 1;
            if (refCount > MAX_REF_IMAGES) return { error: `Attach at most ${MAX_REF_IMAGES} reference images.` };
            totalB64 += data.length;
            if (totalB64 > MAX_TOTAL_B64) return { error: 'Reference images are too large — use smaller images.' };
            clean.push({ inlineData: { mimeType, data } });
        }
        if (!hasText) clean.unshift({ text: prompt }); // guarantee Gemini gets the instruction text
        parts = clean;
    }

    const imageCount = Math.min(Math.max(1, Math.floor(Number(options?.imageCount) || 1)), MAX_IMAGE_COUNT);
    const aspectRatio = ASPECT_RATIOS.has(options?.aspectRatio) ? options.aspectRatio : null;
    const imageSize = IMAGE_SIZES.has(options?.imageSize) ? options.imageSize : null;
    return { request: parts ? { prompt, parts } : { prompt }, imageCount, aspectRatio, imageSize };
}

export const IMAGE_LIMITS = { MAX_PROMPT, MAX_REF_IMAGES, MAX_TOTAL_B64, MAX_IMAGE_COUNT };
