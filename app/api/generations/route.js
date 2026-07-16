import { after } from 'next/server';
import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../lib/gateway/authz.js';
import { apiError } from '../../../lib/gateway/httpError.mjs';
import { effectiveAccess } from '../../../lib/gateway/access.mjs';
import { evaluateQuotas } from '../../../lib/gateway/quota.mjs';
import {
    resolveRouting, insertJob, insertBillingEvent, emitEvent, queuedDepth,
    activeQuotas, usageForQuotas,
} from '../../../lib/gateway/db.js';
import { QUEUE_DEPTH_CAP } from '../../../lib/gateway/queueLogic.mjs';
import { processQueue } from '../../../lib/gateway/processor.mjs';
import { sanitizeImageRequest } from '../../../lib/gateway/validateImageRequest.mjs';
import { estimateCost } from '../../../lib/seedance/pricing.mjs';
import { imageCost } from '../../../lib/gateway/imagePricing.mjs';

// The gateway submit pipeline (design §7):
// AuthN → membership → effectiveAccess → quota+reservation → enqueue → 202.

export const runtime = 'nodejs';
export const maxDuration = 300; // after(processQueue) polls providers past the default timeout

async function accessRows(sql, projectId, userId) {
    const grants = await sql`SELECT * FROM project_model_grants WHERE project_id = ${projectId}`;
    const overrides = await sql`SELECT * FROM user_model_overrides WHERE project_id = ${projectId} AND user_id = ${userId}`;
    const defaults = (await sql`SELECT id FROM models WHERE is_default = true AND active = true`).map((m) => m.id);
    return { grants, overrides, defaultModelIds: defaults };
}

function estimateFor({ category, kind, mode, options = {} }) {
    if (category === 'image') {
        const n = options.imageCount || 1;
        return { usd: imageCost(kind, mode, n, options.imageSize) ?? 0, images: n, video_seconds: 0, requests: 1 };
    }
    const usd = estimateCost({ kind, resolution: options.resolution, duration: options.duration, hasVideoInput: !!options.has_video_input }) ?? 0;
    return { usd, images: 0, video_seconds: options.duration > 0 ? options.duration : 5, requests: 1 };
}

export async function POST(request) {
    const body = await request.json().catch(() => null);
    if (!body?.projectId || !body?.modelId || !body?.request) {
        return apiError('BAD_REQUEST', 'projectId, modelId and request are required.');
    }
    const auth = await gatewayContext({ projectId: body.projectId, permission: 'generation.create' });
    if (!auth.ok) return auth.response;
    const { sql, user, project } = auth.ctx;

    if (project.paused) return apiError('PROJECT_PAUSED', 'This project is paused by an admin.');
    if (await queuedDepth(sql, project.id) >= QUEUE_DEPTH_CAP) {
        return apiError('QUEUE_FULL', `Project queue is full (${QUEUE_DEPTH_CAP} pending).`);
    }

    const rows = await accessRows(sql, project.id, user.userId);
    const decision = effectiveAccess({ modelId: body.modelId, now: new Date(), ...rows });
    if (!decision.allowed) {
        return apiError('MODEL_ACCESS_DENIED', 'You do not have access to this model.', { rule: decision.rule });
    }

    const routing = await resolveRouting(sql, body.modelId);
    if (!routing) return apiError('BAD_REQUEST', 'Unknown or inactive model.');
    const route = routing.routes[0] || {};

    // Image requests are sanitized at the boundary: require a prompt, normalize
    // reference-image parts (image-only, ≤3, size-capped, strip data: prefix),
    // and clamp imageCount so it can't inflate the cost reservation. The video
    // path keeps its own client+server validation and is untouched here.
    let requestBody = body.request;
    if (routing.model.category === 'image') {
        const clean = sanitizeImageRequest(body.request, body.options);
        if (clean.error) return apiError('BAD_REQUEST', clean.error);
        requestBody = clean.request;
        body.options = {
            ...(body.options || {}),
            imageCount: clean.imageCount,
            aspectRatio: clean.aspectRatio,
            imageSize: clean.imageSize,
        };
    }

    const estimate = estimateFor({
        category: routing.model.category, kind: routing.version.kind, mode: route.mode, options: body.options,
    });

    const quotas = await activeQuotas(sql);
    const usage = await usageForQuotas(sql, quotas);
    const verdict = evaluateQuotas({
        quotas, projectId: project.id, userId: user.userId, now: new Date(), estimate, ...usage,
    });
    if (!verdict.ok) {
        const v = verdict.violations[0];
        return apiError('QUOTA_EXCEEDED', 'A budget or quota limit would be exceeded.', {
            limit: { type: v.quota.type, window: v.quota.window, amount: Number(v.quota.hard_limit), scope: v.quota.user_id ? 'user' : v.quota.project_id ? 'project' : 'workspace' },
            resets_at: v.resetsAt,
        });
    }

    const job = await insertJob(sql, {
        projectId: project.id, userId: user.userId, modelId: body.modelId,
        modelVersionId: routing.version.id, priority: body.priority === 'batch' ? 'batch' : 'interactive',
        requestBody: { ...requestBody, options: body.options ?? null, est_cost_usd: estimate.usd, category: routing.model.category },
    });
    await insertBillingEvent(sql, {
        eventType: 'reservation', generationId: job.id, projectId: project.id,
        userId: user.userId, modelId: body.modelId, modelVersionId: routing.version.id,
        units: { images: estimate.images || null, video_seconds: estimate.video_seconds || null },
        estCostUsd: estimate.usd, pricingSnapshot: { basis: 'estimate' },
    });
    await emitEvent(sql, { projectId: project.id, userId: user.userId, type: 'job.status_changed', payload: { jobId: job.id, status: 'queued' } });
    after(() => processQueue().catch(() => {}));

    return NextResponse.json({ generationId: job.id, status: 'queued', estCostUsd: estimate.usd }, { status: 202 });
}

// List generations: own by default; whole project with usage.view + membership.
export async function GET(request) {
    const url = new URL(request.url);
    const projectId = Number(url.searchParams.get('projectId')) || null;
    const scope = url.searchParams.get('scope') === 'project' ? 'project' : 'mine';
    // Optional media-type filter (video | image). Applied server-side so the
    // newest-100 window isn't consumed by the other type — a project with 1000s
    // of videos would otherwise bury every image job past the LIMIT.
    const catParam = url.searchParams.get('category');
    const category = catParam === 'image' || catParam === 'video' ? catParam : null;
    const auth = await gatewayContext(projectId ? { projectId, permission: scope === 'project' ? 'usage.view' : 'generation.create' } : {});
    if (!auth.ok) return auth.response;
    const { sql, user, role } = auth.ctx;

    const rows = projectId
        ? (scope === 'project'
            ? await sql`SELECT * FROM jobs WHERE project_id = ${projectId}
                AND (${category}::text IS NULL OR coalesce(request_body->>'category', 'video') = ${category})
                ORDER BY created_at DESC LIMIT 100`
            : await sql`SELECT * FROM jobs WHERE project_id = ${projectId} AND user_id = ${user.userId}
                AND (${category}::text IS NULL OR coalesce(request_body->>'category', 'video') = ${category})
                ORDER BY created_at DESC LIMIT 100`)
        : await sql`SELECT * FROM jobs WHERE user_id = ${user.userId}
            AND (${category}::text IS NULL OR coalesce(request_body->>'category', 'video') = ${category})
            ORDER BY created_at DESC LIMIT 100`;

    const rolePerms = await sql`SELECT role_id, permission_id FROM role_permissions`;
    const seePrompts = rolePerms.some((r) => r.role_id === role && r.permission_id === 'prompt.view');
    const items = rows.map((j) => ({
        ...j,
        // Q5: viewers see costs/metadata only — prompts stay with the creator
        // and manager+ roles (enforced here, not just hidden in the UI).
        request_body: (j.user_id === user.userId || seePrompts) ? j.request_body : { category: j.request_body?.category ?? null },
    }));
    return NextResponse.json({ items });
}
