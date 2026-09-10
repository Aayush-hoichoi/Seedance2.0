// OpenAI adapter — ChatGPT Images 2.5 (gpt-image-2.5-flare / -sunburst) via the
// org's own OPENAI_API_KEY (the same key the prompt enhancer uses), no reseller
// in between. Same contract as the other adapters: plain result objects, never
// throws, the processor decides retry vs fail through isRetryable().
//
// Unlike kie there is NO task to poll: /v1/images/generations and
// /v1/images/edits answer synchronously with base64 images, so submit() returns
// the Seedream-style sync shape ({ done: true, result }) and poll() can never be
// reached (no providerTaskId is ever written).
//
// One catalog model, two endpoints — the same split kie makes with its two
// slugs: reference images route to /edits (multipart), none to /generations
// (JSON). GPT Image models always return b64_json and REJECT a response_format
// param, so none is sent.

import { classifyOpenAiFailure } from '../../openai/rateLimit.mjs';

const OPENAI_BASE = process.env.OPENAI_API_BASE?.trim() || 'https://api.openai.com';
// High-quality renders run ~30-60s; stay under the 300s image-class route
// timeout so a slow render fails as ours, not as a stranded invocation.
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS) || 180_000;
// Default quality when the request carries none. The user may pick
// low/medium/high (whitelisted at the sanitize boundary, priced per pick in
// imagePricing.mjs QUALITY_FACTORS); 2.5's xhigh/max are never sent.
const QUALITY = process.env.OPENAI_IMAGE_QUALITY?.trim() || 'medium';
const QUALITIES = new Set(['low', 'medium', 'high']);
const qualityFor = (options) => (QUALITIES.has(options?.quality) ? options.quality : QUALITY);

// One catalog row, two engines — like kie's slug split. The route stores the
// flare slug; a user's 'sunburst' pick swaps the suffix. A custom
// OPENAI_IMAGE_MODEL_ID without a known suffix ignores the variant rather than
// mangling the id.
export function variantSlug(providerModelId, variant) {
    if (!variant || !/-(flare|sunburst)$/.test(providerModelId)) return providerModelId;
    return providerModelId.replace(/-(flare|sunburst)$/, `-${variant}`);
}

// --- error mapping --------------------------------------------------------------
//
// OpenAI uses real HTTP statuses, but its 429 covers two OPPOSITE conditions —
// rate limit (retry) vs out of credit (never retry) — and only the body tells
// them apart. classifyOpenAiFailure (shared with the enhancer route) makes that
// call; here it is folded into the gateway's status-based retry semantics.
const CODE_MESSAGES = {
    401: 'OpenAI rejected the API key — check the key stored for the “openai” provider.',
    403: 'OpenAI refused this request — GPT Image models need a verified organization; check the account.',
};

export function mapOpenAiError(status, body) {
    const { kind, retryable } = classifyOpenAiFailure({ status, body });
    if (kind === 'quota') {
        return { status: 400, message: 'The OpenAI account is out of credit — top it up to keep generating.' };
    }
    const message = CODE_MESSAGES[status] || body?.error?.message || `OpenAI returned status ${status}.`;
    // Terminal failures collapse to 400 so isRetryable() never re-pays for a
    // doomed generation; retryable ones keep a retryable status.
    return { status: retryable ? (status === 429 ? 429 : 503) : 400, message };
}

// --- request building -----------------------------------------------------------

// The size to request. 1K rides the three RECOMMENDED sizes (snap by
// orientation; no ratio lets OpenAI pick). 2K/4K use 2.5's custom-dimension
// support: WIDTHxHEIGHT at the exact ratio, computed against a per-tier pixel
// budget under the documented constraints — multiples of 16, no edge over
// 3840, total pixels ≤ 8,294,400 (= 3840×2160, the true ceiling; OpenAI marks
// anything above the 2K class experimental). Every studio ratio fits the
// 1:3–3:1 bound, so no ratio×tier coupling exists here, unlike kie's model.
const TIER_PIXELS = { '2K': 2560 * 1440, '4K': 3840 * 2160 };
const MAX_EDGE = 3840;
const MAX_PIXELS = 3840 * 2160;

export function sizeFor(aspectRatio, imageSize = null) {
    const budget = TIER_PIXELS[imageSize];
    if (!budget) {
        if (!aspectRatio) return 'auto';
        const [w, h] = String(aspectRatio).split(':').map(Number);
        if (!w || !h || w === h) return '1024x1024';
        return w > h ? '1536x1024' : '1024x1536';
    }
    const [rw, rh] = String(aspectRatio || '1:1').split(':').map(Number);
    const ratio = rw > 0 && rh > 0 ? rw / rh : 1;
    let w = Math.sqrt(budget * ratio);
    let h = Math.sqrt(budget / ratio);
    if (w > MAX_EDGE) { w = MAX_EDGE; h = w / ratio; }
    if (h > MAX_EDGE) { h = MAX_EDGE; w = h * ratio; }
    const to16 = (v) => Math.max(16, Math.round(v / 16) * 16);
    w = to16(w); h = to16(h);
    // Rounding both edges up can overshoot the pixel cap by a sliver.
    while (w * h > MAX_PIXELS) { if (w > h) w -= 16; else h -= 16; }
    return `${w}x${h}`;
}

// JSON body for /v1/images/generations (text-to-image).
export function buildBody({ prompt, options = {}, providerModelId = 'gpt-image-2.5-flare' }) {
    const body = {
        model: variantSlug(providerModelId, options.variant),
        prompt,
        size: sizeFor(options.aspectRatio, options.imageSize),
        quality: qualityFor(options),
    };
    if (options.imageCount > 1) body.n = options.imageCount;
    return body;
}

// {inlineData:{mimeType,data}} (the Gemini shape the studio stores refs in) →
// [{ mimeType, data }] with any accidental data: prefix stripped, ready to wrap
// in Blobs for the /edits multipart form.
export function refParts(parts) {
    if (!Array.isArray(parts)) return [];
    return parts
        .filter((p) => typeof p?.inlineData?.data === 'string' && p.inlineData.data)
        .map((p) => {
            let data = p.inlineData.data;
            const m = /^data:([^;]+);base64,/.exec(data);
            if (m) data = data.slice(m[0].length);
            const mimeType = /^image\/[\w.+-]+$/.test(p.inlineData.mimeType || '') ? p.inlineData.mimeType : 'image/png';
            return { mimeType, data };
        });
}

async function openaiFetch(path, { apiKey, body }) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), OPENAI_TIMEOUT_MS);
    try {
        const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
        const res = await fetch(`${OPENAI_BASE}${path}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                // FormData must set its own multipart boundary.
                ...(isForm ? {} : { 'Content-Type': 'application/json' }),
            },
            body: isForm ? body : JSON.stringify(body),
            signal: ctl.signal,
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { /* non-JSON error body */ }
        if (!res.ok) return { ok: false, error: mapOpenAiError(res.status, data) };
        return { ok: true, data };
    } catch (e) {
        if (e.name === 'AbortError') {
            return { ok: false, error: { code: 'ETIMEDOUT', message: `OpenAI did not respond within ${Math.round(OPENAI_TIMEOUT_MS / 1000)}s.` } };
        }
        return { ok: false, error: { code: e.code || 'ENETWORK', message: e.message } };
    } finally {
        clearTimeout(timer);
    }
}

// --- submit (sync) ---------------------------------------------------------------

export async function submit({ job, route, apiKey }) {
    const rb = job.request_body || {};
    const opts = rb.options || {};
    const refs = refParts(rb.parts);

    let r;
    if (refs.length) {
        const form = new FormData();
        form.append('model', variantSlug(route.provider_model_id, opts.variant));
        form.append('prompt', rb.prompt || '');
        form.append('size', sizeFor(opts.aspectRatio, opts.imageSize));
        form.append('quality', qualityFor(opts));
        if (opts.imageCount > 1) form.append('n', String(opts.imageCount));
        refs.forEach((ref, i) => {
            const ext = ref.mimeType.split('/')[1] || 'png';
            form.append('image[]', new Blob([Buffer.from(ref.data, 'base64')], { type: ref.mimeType }), `ref-${i}.${ext}`);
        });
        r = await openaiFetch('/v1/images/edits', { apiKey, body: form });
    } else {
        r = await openaiFetch('/v1/images/generations', {
            apiKey,
            body: buildBody({ prompt: rb.prompt || '', options: opts, providerModelId: route.provider_model_id }),
        });
    }
    if (!r.ok) return r;

    const images = (r.data?.data || [])
        .filter((d) => d?.b64_json || d?.url)
        .map((d) => ({ b64: d.b64_json || null, url: d.url || null, mimeType: 'image/png' }));
    if (!images.length) {
        return { ok: false, error: { status: 400, message: 'OpenAI answered but returned no image — try rephrasing the prompt.' } };
    }
    // usage stays null on purpose: OpenAI reports image tokens, but the gateway
    // bills images flat per-image (imagePricing.mjs); the token-cost branch in
    // settleSuccess is video-only.
    return { ok: true, done: true, result: { images }, usage: null };
}

// Sync provider: submit never writes a providerTaskId, so there is nothing to
// poll or cancel provider-side. Kept for the adapter contract.
export async function poll() {
    return { ok: true, done: false, status: 'running' };
}

export async function cancel() {
    return { ok: true };
}
