// BytePlus ModelArk adapter (video: async task API; image: sync API).
// All functions return plain result objects — never throw for provider-side
// failures — so the processor can decide retry vs fail via isRetryable().

const ARK_BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3';

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
    const body = { ...job.request_body, model: route.provider_model_id };
    if (job.request_body?.category === 'image' || route.category === 'image') {
        const r = await arkFetch('images/generations', { method: 'POST', apiKey, body });
        if (!r.ok) return r;
        return {
            ok: true,
            done: true,
            result: { images: (r.data?.data || []).map((d) => ({ url: d.url || null, b64: d.b64_json || null })) },
            usage: r.data?.usage || null,
        };
    }
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
