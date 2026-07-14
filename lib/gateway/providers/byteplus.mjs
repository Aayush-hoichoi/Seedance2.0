// BytePlus ModelArk adapter (video: async task API; image: sync API).
// All functions return plain result objects — never throw for provider-side
// failures — so the processor can decide retry vs fail via isRetryable().

const ARK_BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3';

// Seedream 5.0 `size`: total pixels MUST be in [3,686,400 .. 16,777,216] and
// each edge ≤4096 (verified against the live API — 1K and small WxH are 400s).
// We honour the studio's aspect ratio + resolution tier by hitting a per-tier
// pixel budget at the requested ratio, preserving ratio (scale down if an edge
// would exceed 4096) and scaling up to the floor if needed.
const SEEDREAM_MIN_PX = 3_686_400;
const SEEDREAM_MAX_EDGE = 4096;
const SEEDREAM_BUDGET = { '2K': 4_194_304, '4K': 16_777_216 }; // 1K is below the floor
function seedreamSize(aspectRatio, imageSize) {
    const budget = SEEDREAM_BUDGET[imageSize] || SEEDREAM_BUDGET['2K'];
    const m = /^(\d+):(\d+)$/.exec(aspectRatio || '');
    const rw = m ? Number(m[1]) : 1;
    const rh = m ? Number(m[2]) : 1;
    let W = Math.sqrt((budget * rw) / rh);
    let H = Math.sqrt((budget * rh) / rw);
    const down = Math.min(1, SEEDREAM_MAX_EDGE / Math.max(W, H));
    W *= down; H *= down;
    if (W * H < SEEDREAM_MIN_PX) {
        const up = Math.sqrt(SEEDREAM_MIN_PX / (W * H));
        W = Math.min(SEEDREAM_MAX_EDGE, W * up);
        H = Math.min(SEEDREAM_MAX_EDGE, H * up);
    }
    return `${Math.round(W)}x${Math.round(H)}`;
}
export { seedreamSize };

async function arkFetch(path, { method = 'GET', apiKey, body } = {}) {
    try {
        const res = await fetch(`${ARK_BASE}/${path}`, {
            method,
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { /* non-JSON error body */ }
        if (!res.ok) return { ok: false, error: { status: res.status, message: data?.error?.message || text.slice(0, 300) } };
        return { ok: true, data };
    } catch (e) {
        return { ok: false, error: { code: e.code || 'ENETWORK', message: e.message } };
    }
}

// Submit one job. Video → async task ({ providerTaskId }); image (Seedream) →
// sync response ({ done: true, result, usage }).
export async function submit({ job, route, apiKey }) {
    const rb = job.request_body || {};
    if (rb.category === 'image' || route.category === 'image') {
        // Build a CLEAN images/generations body — the job's request_body carries
        // Gemini-shaped fields (parts) + gateway metadata (options, category,
        // est_cost_usd) that this API rejects. Ask for b64 so storeImages()
        // persists to our bucket instead of BytePlus's expiring TOS url.
        const opts = rb.options || {};
        const body = {
            model: route.provider_model_id,
            prompt: rb.prompt,
            size: seedreamSize(opts.aspectRatio, opts.imageSize),
            response_format: 'b64_json',
            watermark: false,
        };
        const r = await arkFetch('images/generations', { method: 'POST', apiKey, body });
        if (!r.ok) return r;
        return {
            ok: true,
            done: true,
            result: { images: (r.data?.data || []).map((d) => ({ url: d.url || null, b64: d.b64_json || null, mimeType: 'image/png' })) },
            usage: r.data?.usage || null,
        };
    }
    const body = { ...rb, model: route.provider_model_id };
    const r = await arkFetch('contents/generations/tasks', { method: 'POST', apiKey, body });
    if (!r.ok) return r;
    return { ok: true, providerTaskId: r.data?.id || null };
}

// Poll an async video task → { ok, done, status, result?, usage?, error? }.
export async function poll({ job, apiKey }) {
    const r = await arkFetch(`contents/generations/tasks/${encodeURIComponent(job.provider_task_id)}`, { apiKey });
    if (!r.ok) return r;
    const status = r.data?.status;
    if (status === 'succeeded') {
        return {
            ok: true, done: true, status,
            result: { video_url: r.data?.content?.video_url || null },
            usage: r.data?.usage || null,
        };
    }
    if (status === 'failed' || status === 'cancelled') {
        return { ok: true, done: true, status: 'failed', error: { status: 400, message: r.data?.error?.message || status } };
    }
    return { ok: true, done: false, status: status || 'running' };
}

export async function cancel({ job, apiKey }) {
    if (!job.provider_task_id) return { ok: true };
    const r = await arkFetch(`contents/generations/tasks/${encodeURIComponent(job.provider_task_id)}`, { method: 'DELETE', apiKey });
    return { ok: r.ok };
}
