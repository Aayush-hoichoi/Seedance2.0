import { NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { getApprovedModelIds, logUsage } from '../../../../lib/access/db.js';
import { MODELS, GATED_MODEL_IDS } from '../../../../lib/seedance/constants.js';
import { canUseModel } from '../../../../lib/access/decision.mjs';
import { estimateCost } from '../../../../lib/seedance/pricing.mjs';
import { getDb } from '../../../../lib/db/neon.js';
import { effectiveAccess } from '../../../../lib/gateway/access.mjs';
import { evaluateQuotas } from '../../../../lib/gateway/quota.mjs';
import { activeQuotas, usageForQuotas, insertBillingEvent, emitEvent } from '../../../../lib/gateway/db.js';

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

// Resolve the gateway context for a studio create-task call. Returns:
//   null                  → gateway not migrated yet (legacy check applies)
//   { error: Response }   → governed and rejected
//   { sql, org, project, alias, versionId, kind, estimate } → governed, allowed
async function resolveGateway(request, user, modelId) {
    const sql = await getDb();
    if (!sql) return null;
    const [org] = await sql`SELECT * FROM organizations WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`;
    if (!org) return null;
    const [version] = await sql`SELECT v.*, m.category FROM model_versions v
        JOIN models m ON m.id = v.model_id WHERE v.version_tag = ${modelId} LIMIT 1`;
    if (!version) return null;

    // Project: explicit header → that project (must be a member); else Default.
    const headerId = Number(request.headers.get('x-seedance-project')) || null;
    const [project] = headerId
        ? await sql`SELECT p.* FROM projects p JOIN project_memberships m ON m.project_id = p.id AND m.user_id = ${user.userId}
            WHERE p.id = ${headerId} AND p.archived_at IS NULL`
        : await sql`SELECT p.* FROM projects p JOIN project_memberships m ON m.project_id = p.id AND m.user_id = ${user.userId}
            WHERE p.org_id = ${org.id} AND p.archived_at IS NULL ORDER BY (p.name = 'Default') DESC, p.id ASC LIMIT 1`;
    if (!project) {
        return { error: NextResponse.json({ code: 'NOT_A_PROJECT_MEMBER', error: 'You are not in any project yet — ask an admin to add you.' }, { status: 403 }) };
    }
    if (project.paused) {
        return { error: NextResponse.json({ code: 'PROJECT_PAUSED', error: 'This project is paused by an admin.' }, { status: 409 }) };
    }

    const grants = await sql`SELECT * FROM project_model_grants WHERE project_id = ${project.id}`;
    const overrides = await sql`SELECT * FROM user_model_overrides WHERE project_id = ${project.id} AND user_id = ${user.userId}`;
    const defaults = (await sql`SELECT id FROM models WHERE is_default = true AND active = true`).map((m) => m.id);
    const decision = effectiveAccess({ modelId: version.model_id, now: new Date(), grants, overrides, defaultModelIds: defaults });
    if (!decision.allowed) {
        return { error: NextResponse.json({ code: 'MODEL_ACCESS_DENIED', rule: decision.rule, error: 'You do not have access to this model. Request access from the model picker.' }, { status: 403 }) };
    }
    return { sql, org, project, alias: version.model_id, versionId: version.id, kind: version.kind };
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

    // Governance. Once the gateway migration has run (org/project/catalog rows
    // exist) the FULL pipeline applies: project scoping, precedence-based
    // access, layered quotas with reservations, billing events, SSE. Before
    // that, fall back to the legacy per-user approved-model check.
    let gw = null;
    try {
        gw = await resolveGateway(request, user, modelId);
    } catch { gw = null; } // DB hiccup: fail open to the legacy check below
    if (gw?.error) return gw.error;

    if (!gw) {
        const approvedModelIds = GATED_MODEL_IDS.includes(modelId) ? await getApprovedModelIds(user.userId) : [];
        if (!canUseModel({ modelId, gatedModelIds: GATED_MODEL_IDS, approvedModelIds })) {
            return NextResponse.json(
                { error: 'You do not have access to this model. Request access from the model picker.' },
                { status: 403 },
            );
        }
    }

    // Quota check + reservation happen BEFORE the provider sees the request.
    const kind = gw?.kind ?? MODELS.find((m) => m.id === modelId)?.kind ?? null;
    const withVideo = hasVideoInput(parsed?.content);
    const estUsd = kind ? estimateCost({ kind, resolution: parsed?.resolution, duration: parsed?.duration }) : null;
    if (gw) {
        const quotas = await activeQuotas(gw.sql, gw.org.id);
        const usage = await usageForQuotas(gw.sql, quotas);
        const verdict = evaluateQuotas({
            quotas, projectId: gw.project.id, userId: user.userId, now: new Date(),
            estimate: { usd: estUsd ?? 0, video_seconds: parsed?.duration || 5, requests: 1 }, ...usage,
        });
        if (!verdict.ok) {
            const v = verdict.violations[0];
            return NextResponse.json({
                code: 'QUOTA_EXCEEDED',
                error: `Budget limit reached (${v.quota.type} · ${v.quota.window})${v.resetsAt ? ` — resets ${new Date(v.resetsAt).toLocaleString()}` : ''}.`,
                resets_at: v.resetsAt,
            }, { status: 429 });
        }
    }

    // Forward to ModelArk, then record the generation on success.
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
        const usageRow = {
            userId: user.userId,
            email: user.email,
            modelId,
            resolution: parsed?.resolution ?? null,
            duration: typeof parsed?.duration === 'number' ? parsed.duration : null,
            ratio: parsed?.ratio ?? null,
            mode: request.headers.get('x-seedance-mode') || null,
            hasVideoInput: withVideo,
            taskId: data.id,
            estCostUsd: estUsd,
        };
        if (gw) {
            // Gateway record: job row (running — ModelArk holds the work) +
            // budget reservation + live event. Settled by /api/usage/complete.
            const [job] = await gw.sql`INSERT INTO jobs
                (org_id, project_id, user_id, model_id, model_version_id, priority, status, attempt,
                 request_body, provider_task_id, provider_id, started_at, timeout_at)
                VALUES (${gw.org.id}, ${gw.project.id}, ${user.userId}, ${gw.alias}, ${gw.versionId}, 'interactive', 'running', 1,
                        ${JSON.stringify({ options: { resolution: parsed?.resolution ?? null, duration: parsed?.duration ?? null, ratio: parsed?.ratio ?? null, mode: usageRow.mode, has_video_input: withVideo, kind }, est_cost_usd: estUsd, category: 'video' })},
                        ${data.id}, 'byteplus', now(), now() + interval '30 minutes')
                RETURNING id`;
            await insertBillingEvent(gw.sql, {
                eventType: 'reservation', generationId: job.id, orgId: gw.org.id, projectId: gw.project.id,
                userId: user.userId, modelId: gw.alias, modelVersionId: gw.versionId, providerId: 'byteplus',
                units: { video_seconds: parsed?.duration || 5 }, estCostUsd: estUsd, pricingSnapshot: { basis: 'estimate' },
            });
            await emitEvent(gw.sql, { orgId: gw.org.id, projectId: gw.project.id, userId: user.userId, type: 'job.status_changed', payload: { jobId: job.id, taskId: data.id, status: 'running' } });
        } else {
            await logUsage(usageRow); // pre-migration fallback
        }
    }

    return data
        ? NextResponse.json(data, { status: response.status })
        : NextResponse.json({ error: text.slice(0, 500) || response.statusText }, { status: response.status });
}
