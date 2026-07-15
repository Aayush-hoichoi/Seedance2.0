// Google Gemini Batch API adapter for Nano Banana image models (design §5).
// Batch mode = 50% pricing; async: submit N requests as ONE batch, poll the
// operation, retrieve inlined responses mapped back to jobs by metadata key.
// Routes stay 'disabled' until GOOGLE_API_KEY exists — this code ships ready.

const GL_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// A bare fetch with no timeout can hang the whole serverless invocation (a 4K
// Nano Banana Pro call is heavy) — and an interactive job that never returns is
// stranded with no provider handle for pollRunningJobs to resume. Bound it just
// under the function's maxDuration (300s) so control returns for a clean retry.
const GL_TIMEOUT_MS = Number(process.env.GOOGLE_IMAGE_TIMEOUT_MS) || 290_000;

async function glFetch(path, { method = 'GET', apiKey, body } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), GL_TIMEOUT_MS);
    try {
        const res = await fetch(`${GL_BASE}/${path}`, {
            method,
            headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
            signal: ctl.signal,
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { /* non-JSON error body */ }
        if (!res.ok) return { ok: false, error: { status: res.status, message: data?.error?.message || text.slice(0, 300) } };
        return { ok: true, data };
    } catch (e) {
        // Abort → a retryable timeout, so the job retries on a fresh invocation
        // rather than hanging until the sweep declares it timed out.
        if (e.name === 'AbortError') {
            return { ok: false, error: { code: 'ETIMEDOUT', message: `The image model did not respond within ${Math.round(GL_TIMEOUT_MS / 1000)}s — try a lower resolution.` } };
        }
        return { ok: false, error: { code: e.code || 'ENETWORK', message: e.message } };
    } finally {
        clearTimeout(timer);
    }
}

// One request per job: prompt (+ optional reference images already inlined by
// the API layer as {inlineData} parts). metadata.key ties responses to jobs.
// aspectRatio / imageSize (sanitized in validateImageRequest) ride in
// generationConfig.imageConfig — omitted keys let Gemini use its defaults.
function batchRequests(jobs) {
    return jobs.map((job) => {
        const opts = job.request_body?.options || {};
        const imageConfig = {};
        if (opts.aspectRatio) imageConfig.aspectRatio = opts.aspectRatio;
        if (opts.imageSize) imageConfig.imageSize = opts.imageSize;
        return {
            request: {
                contents: [{ parts: job.request_body?.parts || [{ text: job.request_body?.prompt || '' }] }],
                generationConfig: {
                    responseModalities: ['IMAGE'],
                    ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
                },
            },
            metadata: { key: String(job.id) },
        };
    });
}

// Submit a coalesced burst of jobs → { ok, batchName }.
export async function submitBatch({ jobs, providerModelId, apiKey }) {
    const r = await glFetch(`models/${providerModelId}:batchGenerateContent`, {
        method: 'POST',
        apiKey,
        body: {
            batch: {
                displayName: `gateway-${jobs[0]?.id}-${jobs.length}`,
                inputConfig: { requests: { requests: batchRequests(jobs) } },
            },
        },
    });
    if (!r.ok) return r;
    return { ok: true, batchName: r.data?.name || null };
}

// Interactive (synchronous) generateContent — the image comes back in ONE call,
// no batch, no polling. Reuses batchRequests() so the request body + response
// parsing are identical to the (now-retired) batch path.
export async function submit({ job, providerModelId, apiKey }) {
    const [{ request }] = batchRequests([job]);
    const r = await glFetch(`models/${providerModelId}:generateContent`, { method: 'POST', apiKey, body: request });
    if (!r.ok) return r;
    const candidate = r.data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const images = parts
        .filter((p) => p.inlineData?.data)
        .map((p) => ({ b64: p.inlineData.data, mimeType: p.inlineData.mimeType || 'image/png' }));
    if (images.length) return { ok: true, done: true, result: { images }, usage: r.data?.usageMetadata || null };
    const reason = candidate?.finishReason || r.data?.promptFeedback?.blockReason;
    const blocked = reason && reason !== 'STOP';
    return { ok: false, error: { status: 400, message: blocked
        ? `Image was blocked by the model's safety filter (${reason}). Try a different prompt or reference image.`
        : 'The model returned no image — try rephrasing the prompt.' } };
}

// Poll a batch operation → { ok, done, byKey: { [jobId]: { images | error } } }.
// Retained only to DRAIN batches already in flight when batch mode was removed.
export async function pollBatch({ batchName, apiKey }) {
    const r = await glFetch(batchName, { apiKey });
    if (!r.ok) return r;
    if (!r.data?.done) return { ok: true, done: false };

    const inlined = r.data?.response?.inlinedResponses?.inlinedResponses
        || r.data?.response?.inlinedResponses || [];
    const byKey = {};
    for (const item of inlined) {
        const key = item?.metadata?.key;
        if (!key) continue;
        if (item.error) {
            byKey[key] = { error: { status: 400, message: item.error.message || 'batch item failed' } };
            continue;
        }
        const candidate = item.response?.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        const images = parts
            .filter((p) => p.inlineData?.data)
            .map((p) => ({ b64: p.inlineData.data, mimeType: p.inlineData.mimeType || 'image/png' }));
        if (images.length) { byKey[key] = { images }; continue; }
        // No image bytes: distinguish a content-safety / policy block (the most
        // common real failure) from an empty result, so the user gets an
        // actionable message instead of a generic "no image".
        const reason = candidate?.finishReason || item.response?.promptFeedback?.blockReason;
        const blocked = reason && reason !== 'STOP';
        byKey[key] = { error: { status: 400, message: blocked
            ? `Image was blocked by the model's safety filter (${reason}). Try a different prompt or reference image.`
            : 'The model returned no image — try rephrasing the prompt.' } };
    }
    return { ok: true, done: true, byKey };
}

export async function cancelBatch({ batchName, apiKey }) {
    const r = await glFetch(`${batchName}:cancel`, { method: 'POST', apiKey });
    return { ok: r.ok };
}
