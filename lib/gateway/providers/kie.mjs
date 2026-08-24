// kie.ai adapter — GPT Image 2 ("ChatGPT Image 2"), async task API.
// Same contract as the byteplus/google adapters: every function returns a plain
// result object and never throws for provider-side failures, so the processor
// decides retry vs fail through isRetryable().
//
// Shape (verified against docs.kie.ai, 2026-08-22):
//   POST /api/v1/jobs/createTask   { model, callBackUrl?, input:{…} } -> data.taskId
//   GET  /api/v1/jobs/recordInfo?taskId=…  -> data.state + data.resultJson
// The unified recordInfo endpoint serves every Market model, so this adapter
// generalises to other kie models: only slugFor()/buildInput() are GPT-Image-2
// specific.
//
// Two things about this API are unlike the others we talk to and are handled
// deliberately below: it reports FAILURES INSIDE AN HTTP 200 body (`code`), and
// it returns results as EXPIRING URLS (~24h), not bytes.

import { clampImageResolution } from '../../seedance/constants.js';

const KIE_BASE = process.env.KIE_API_BASE?.trim() || 'https://api.kie.ai';
// File upload lives on its own host (docs: "File Upload API"). Free, and the
// uploads expire on their own, so nothing here needs cleaning up.
const KIE_UPLOAD_BASE = process.env.KIE_UPLOAD_BASE?.trim() || 'https://kieai.redpandaai.co';
// Well under the function's maxDuration (300s): createTask/recordInfo return in
// under a second, and reference uploads are ~1MB each. An unbounded fetch would
// strand the invocation with no provider handle to resume from.
const KIE_TIMEOUT_MS = Number(process.env.KIE_TIMEOUT_MS) || 60_000;

// --- error mapping --------------------------------------------------------------
//
// kie answers HTTP 200 and puts the real outcome in `code`. Passing those codes
// through as HTTP status would be actively harmful: isRetryable() retries
// anything >= 500, so 501 ("Generation Failed") and 505 ("Feature Disabled")
// would each be retried 3× with backoff — paying for the same doomed generation
// three times. Map to OUR retry semantics instead:
//   terminal (status 400): bad input, auth, credits, policy, permanent failure
//   retryable: 429 rate limit, 455 maintenance, 500 server error
const TERMINAL_CODES = new Set([400, 401, 402, 404, 422, 433, 501, 505]);
const RETRYABLE_CODES = new Set([429, 455, 500, 502, 503, 504]);

// Messages worth rewriting: the raw text is either absent or unactionable.
const CODE_MESSAGES = {
    401: 'kie.ai rejected the API key — check the key stored for the “kie” provider.',
    402: 'The kie.ai account is out of credits — top it up to keep generating.',
    429: 'kie.ai is rate-limiting this account — the job will retry shortly.',
    455: 'kie.ai is under maintenance — the job will retry shortly.',
};

export function mapKieCode(code, message) {
    const text = CODE_MESSAGES[code] || message || `kie.ai returned code ${code}.`;
    if (RETRYABLE_CODES.has(code)) return { status: code === 429 ? 429 : 503, message: text };
    if (TERMINAL_CODES.has(code)) return { status: 400, message: text };
    // Unknown code: treat as terminal. Retrying an outcome we cannot classify
    // spends money on a guess.
    return { status: 400, message: text };
}

async function kieFetch(url, { method = 'GET', apiKey, body } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), KIE_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method,
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
            signal: ctl.signal,
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { /* non-JSON error body */ }
        if (!res.ok) return { ok: false, error: { status: res.status, message: data?.msg || data?.error || text.slice(0, 300) } };
        // HTTP 200 with a non-200 `code` is the normal failure channel here.
        const code = Number(data?.code);
        if (code && code !== 200) return { ok: false, error: mapKieCode(code, data?.msg) };
        return { ok: true, data: data?.data ?? data };
    } catch (e) {
        if (e.name === 'AbortError') {
            return { ok: false, error: { code: 'ETIMEDOUT', message: `kie.ai did not respond within ${Math.round(KIE_TIMEOUT_MS / 1000)}s.` } };
        }
        return { ok: false, error: { code: e.code || 'ENETWORK', message: e.message } };
    } finally {
        clearTimeout(timer);
    }
}

// --- request building -----------------------------------------------------------

// One catalog model, two provider slugs. The route's provider_model_id holds the
// text-to-image slug; the image-to-image sibling is derived from it so a slug
// rotation stays a single env/DB change (and is overridable outright). Sending
// input_urls to the t2i slug is a 422, so this mapping is load-bearing.
export function slugFor(providerModelId, hasRefs) {
    if (!hasRefs) return providerModelId;
    if (process.env.KIE_GPT_IMAGE_2_I2I_MODEL_ID) return process.env.KIE_GPT_IMAGE_2_I2I_MODEL_ID.trim();
    return providerModelId.replace(/-text-to-image$/, '-image-to-image');
}

// {inlineData:{mimeType,data}} (the Gemini shape the studio stores refs in) →
// "data:<mime>;base64,<data>", which kie's base64 upload accepts directly.
export function refDataUrls(parts) {
    if (!Array.isArray(parts)) return [];
    return parts
        .filter((p) => typeof p?.inlineData?.data === 'string' && p.inlineData.data)
        .map((p) => {
            const data = p.inlineData.data;
            if (data.startsWith('data:')) return data;
            const mime = /^image\/[\w.+-]+$/.test(p.inlineData.mimeType || '') ? p.inlineData.mimeType : 'image/png';
            return `data:${mime};base64,${data}`;
        });
}

// The `input` object for createTask. aspectRatio/imageSize were already clamped
// to a combination this model accepts at the submit boundary (enqueue.mjs);
// clamping again here is defence in depth for any caller that skipped it —
// silently rendering 2K is far better than a task kie refuses to create.
// Omitted keys are left out entirely so kie applies its own defaults.
export function buildInput({ prompt, options = {}, inputUrls = [], modelId = 'chatgpt-image-2' }) {
    const input = { prompt };
    if (inputUrls.length) input.input_urls = inputUrls;
    if (options.aspectRatio) input.aspect_ratio = options.aspectRatio;
    const resolution = clampImageResolution(modelId, options.aspectRatio ?? null, options.imageSize ?? null);
    if (resolution) input.resolution = resolution;
    return input;
}

// Upload one reference image and return its public URL. kie takes references as
// URLs only, and the studio holds them as base64 — this is the bridge.
async function uploadRef({ dataUrl, apiKey, jobId, index }) {
    const r = await kieFetch(`${KIE_UPLOAD_BASE}/api/file-base64-upload`, {
        method: 'POST',
        apiKey,
        body: {
            base64Data: dataUrl,
            uploadPath: 'images/gateway',
            // Job id + index keys the name to one generation: kie OVERWRITES on a
            // filename collision, so a shared name would let two concurrent jobs
            // clobber each other's references.
            fileName: `job-${jobId}-ref-${index}`,
        },
    });
    if (!r.ok) return r;
    const url = r.data?.downloadUrl || r.data?.fileUrl;
    if (!url) return { ok: false, error: { status: 400, message: 'kie.ai accepted the reference image but returned no URL.' } };
    return { ok: true, url };
}

// --- submit / poll / cancel -------------------------------------------------------

// Submit one job → { ok, providerTaskId }. Always async here: kie returns a
// taskId and the processor polls it (pollUntilBudget, then pollRunningJobs).
export async function submit({ job, route, apiKey }) {
    const rb = job.request_body || {};
    const opts = rb.options || {};
    const dataUrls = refDataUrls(rb.parts);

    const inputUrls = [];
    for (let i = 0; i < dataUrls.length; i += 1) {
        const up = await uploadRef({ dataUrl: dataUrls[i], apiKey, jobId: job.id, index: i });
        // A reference the user deliberately attached is NOT droppable. Seedream
        // once silently discarded every reference and answered from the prompt
        // alone; the user cannot see that happen, so fail loudly instead.
        if (!up.ok) {
            return { ok: false, error: { ...up.error, message: `Could not upload a reference image to kie.ai: ${up.error.message}` } };
        }
        inputUrls.push(up.url);
    }

    const r = await kieFetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
        method: 'POST',
        apiKey,
        body: {
            model: slugFor(route.provider_model_id, inputUrls.length > 0),
            input: buildInput({ prompt: rb.prompt || '', options: opts, inputUrls, modelId: job.model_id }),
        },
    });
    if (!r.ok) return r;
    const taskId = r.data?.taskId || null;
    if (!taskId) return { ok: false, error: { status: 400, message: 'kie.ai accepted the request but returned no task id.' } };
    return { ok: true, providerTaskId: taskId };
}

// data.resultJson is a JSON *string* — not an object — holding { resultUrls }.
export function parseResultUrls(resultJson) {
    if (!resultJson) return [];
    let parsed = resultJson;
    if (typeof resultJson === 'string') {
        try { parsed = JSON.parse(resultJson); } catch { return []; }
    }
    const urls = parsed?.resultUrls;
    return Array.isArray(urls) ? urls.filter((u) => typeof u === 'string' && u) : [];
}

// kie hands back URLs that expire in ~24h. Pull the bytes here so settleSuccess →
// storeImages() persists them to our own bucket, the way every other image model
// already behaves. On a download failure we fall back to the raw URL rather than
// losing a generation the user has already paid for — same trade storeImages
// makes — but say so in the log, because the gallery entry will rot next day.
async function downloadImages(urls, jobId) {
    const images = [];
    for (const url of urls) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(KIE_TIMEOUT_MS) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buf = Buffer.from(await res.arrayBuffer());
            images.push({ b64: buf.toString('base64'), mimeType: res.headers.get('content-type') || 'image/png' });
        } catch (err) {
            console.error(`[kie] job ${jobId}: could not download ${url} — storing the expiring provider URL instead: ${err.message}`);
            images.push({ url, mimeType: 'image/png' });
        }
    }
    return images;
}

// Poll a task → { ok, done, status, result?, error? }.
export async function poll({ job, apiKey }) {
    const r = await kieFetch(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(job.provider_task_id)}`, { apiKey });
    if (!r.ok) return r;
    const state = r.data?.state;

    if (state === 'success') {
        const urls = parseResultUrls(r.data?.resultJson);
        if (!urls.length) {
            return { ok: true, done: true, status: 'failed', error: { status: 400, message: 'kie.ai reported success but returned no image — try rephrasing the prompt.' } };
        }
        // usage stays null on purpose: kie reports creditsConsumed, not tokens,
        // and image billing is per-image from imagePricing.mjs. The token-cost
        // branch in settleSuccess is video-only.
        return { ok: true, done: true, status: 'succeeded', result: { images: await downloadImages(urls, job.id) }, usage: null };
    }

    if (state === 'fail') {
        const code = Number(r.data?.failCode);
        const message = r.data?.failMsg || 'The image generation failed.';
        return { ok: true, done: true, status: 'failed', error: code ? mapKieCode(code, message) : { status: 400, message } };
    }

    // waiting | queuing | generating
    return { ok: true, done: false, status: state || 'running' };
}

// kie documents no task-cancel endpoint. cancelJob() still marks our row
// cancelled and releases the reservation; the provider-side task runs to
// completion and its result is discarded, which is the behaviour design §4.7
// already describes for a provider that cannot cancel.
export async function cancel() {
    return { ok: true };
}
