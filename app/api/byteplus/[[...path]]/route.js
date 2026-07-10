import { NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { getApprovedModelIds, logUsage } from '../../../../lib/access/db.js';
import { MODELS, GATED_MODEL_IDS } from '../../../../lib/seedance/constants.js';
import { canUseModel } from '../../../../lib/access/decision.mjs';
import { estimateCost } from '../../../../lib/seedance/pricing.mjs';

// Server-side proxy to BytePlus ModelArk. The browser calls /api/byteplus/*,
// this route re-issues the request to ModelArk with the Bearer key injected
// from the server-only ARK_API_KEY env var. Keeps the key out of the client
// and sidesteps ModelArk CORS (it has no browser-facing CORS headers).
//
// The create-task path additionally enforces per-user model access (gated
// models need an approved grant) and logs a usage_events row on success.

export const runtime = 'nodejs';

const ARK_BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3';
const CREATE_TASK_PATH = 'contents/generations/tasks';

function hasVideoInput(content) {
    return Array.isArray(content) && content.some((c) => c?.type === 'video_url' || c?.role === 'reference_video');
}

function buildTargetUrl(pathSegments, requestUrl) {
    const path = (pathSegments || []).join('/');
    const { search } = new URL(requestUrl);
    return `${ARK_BASE}/${path}${search}`;
}

function arkHeaders(extra = {}) {
    const key = process.env.ARK_API_KEY;
    if (!key) return null;
    return {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...extra,
    };
}

function missingKeyResponse() {
    return NextResponse.json(
        { error: 'ARK_API_KEY is not configured on the server. Add it to .env.local and restart the dev server.' },
        { status: 500 },
    );
}

async function forward(targetUrl, init) {
    const response = await fetch(targetUrl, init);
    const text = await response.text();
    // ModelArk returns JSON; pass through status + body. Fall back to raw text
    // so upstream error pages still surface useful detail to the client.
    try {
        return NextResponse.json(JSON.parse(text), { status: response.status });
    } catch {
        return NextResponse.json(
            { error: text.slice(0, 500) || response.statusText },
            { status: response.status },
        );
    }
}

export async function GET(request, { params }) {
    const headers = arkHeaders();
    if (!headers) return missingKeyResponse();
    const { path } = await params;
    const targetUrl = buildTargetUrl(path, request.url);
    try {
        return await forward(targetUrl, { method: 'GET', headers });
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 502 });
    }
}

export async function POST(request, { params }) {
    const headers = arkHeaders();
    if (!headers) return missingKeyResponse();
    const { path } = await params;
    const joined = (path || []).join('/');
    const body = await request.text();
    const targetUrl = buildTargetUrl(path, request.url);

    // Only the create-task path is gated + logged; all other paths forward as-is.
    if (joined !== CREATE_TASK_PATH) {
        try {
            return await forward(targetUrl, { method: 'POST', headers, body });
        } catch (error) {
            return NextResponse.json({ error: error.message }, { status: 502 });
        }
    }

    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    const modelId = parsed?.model;

    // Access check — only hit the DB for gated models.
    const approvedModelIds = GATED_MODEL_IDS.includes(modelId) ? await getApprovedModelIds(user.userId) : [];
    if (!canUseModel({ modelId, gatedModelIds: GATED_MODEL_IDS, approvedModelIds })) {
        return NextResponse.json(
            { error: 'You do not have access to this model. Request access from the model picker.' },
            { status: 403 },
        );
    }

    // Forward to ModelArk, then log usage on success (with the returned task id).
    let response;
    try {
        response = await fetch(targetUrl, { method: 'POST', headers, body });
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 502 });
    }
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }

    if (response.ok && data?.id) {
        const kind = MODELS.find((m) => m.id === modelId)?.kind ?? null;
        const withVideo = hasVideoInput(parsed?.content);
        await logUsage({
            userId: user.userId,
            email: user.email,
            modelId,
            resolution: parsed?.resolution ?? null,
            duration: typeof parsed?.duration === 'number' ? parsed.duration : null,
            ratio: parsed?.ratio ?? null,
            mode: request.headers.get('x-seedance-mode') || null,
            hasVideoInput: withVideo,
            taskId: data.id,
            estCostUsd: kind ? estimateCost({ kind, resolution: parsed?.resolution, duration: parsed?.duration }) : null,
        });
    }

    return data
        ? NextResponse.json(data, { status: response.status })
        : NextResponse.json({ error: text.slice(0, 500) || response.statusText }, { status: response.status });
}
