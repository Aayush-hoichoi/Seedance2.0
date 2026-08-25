// lib/gateway/enqueue.mjs — the governed generation-submit pipeline, extracted
// from app/api/generations/route.js's POST so the HTTP route and the MCP
// create_image tool share the identical AuthN → membership → effectiveAccess
// → quota+reservation → enqueue pipeline (design §7). Framework-free (no
// next/server import) so it runs from the MCP tool path too. The queue kick
// (processQueue) stays OUT of this module — callers fire it themselves, since
// the route uses next/server's after() and the MCP tool path may not be able to.

import { gatewayContextFor } from './authz.js';
import { STATUS } from './httpError.mjs';
import { effectiveAccess } from './access.mjs';
import { evaluateQuotas } from './quota.mjs';
import {
    resolveRouting, insertJob, reserveBillingEvent, emitEvent, queuedDepth,
    activeQuotas, usageForQuotas,
} from './db.js';
import { QUEUE_DEPTH_CAP } from './queueLogic.mjs';
import { sanitizeImageRequest } from './validateImageRequest.mjs';
import { RESOLUTIONS, IMAGE_RESOLUTIONS, resolutionWithinTier, imageRefMax } from '../seedance/constants.js';
import { estimateCost } from '../seedance/pricing.mjs';
import { imageCost } from './imagePricing.mjs';

function err(code, message, detail = {}) {
    return { status: STATUS[code] ?? 400, body: { code, message, ...detail }, enqueued: false };
}

// Every refusal below returns before insertJob, so until now a generation the
// gateway turned away left NO trace anywhere: not in jobs, not in the ledger,
// not in any count. It was indistinguishable from never having pressed the
// button — and quota and access refusals are among the most operationally
// interesting things the platform does. (The content inventory records the
// same loss for the pre-gateway era: "anything rejected before task creation
// left no trace at all.")
//
// So a refusal writes a terminal `rejected` job row. It gets an id, therefore
// a ledger row key, therefore a line in both workbooks — with a blank cost and
// the reason in Failure Reason. processQueue only ever claims `queued`, so a
// rejected row is never run.
//
// Strictly best-effort: a logging failure must never turn a clean 4xx into a
// 500, so every error here is swallowed.
async function recordRejection(sql, ctx, code, message) {
    if (!sql || !ctx?.projectId || !ctx?.userId || !ctx?.modelId) return;
    try {
        await sql`INSERT INTO jobs
                (project_id, user_id, model_id, model_version_id, priority, status,
                 request_body, error, finished_at)
            VALUES (${ctx.projectId}, ${ctx.userId}, ${ctx.modelId}, ${ctx.modelVersionId ?? null},
                    ${ctx.priority || 'interactive'}, 'rejected',
                    ${JSON.stringify(ctx.requestBody || {})}, ${JSON.stringify({ code, message })}, now())`;
    } catch (error) {
        console.error(`[ledger] could not record ${code} rejection — ${error.message}`);
    }
}

// err(), but leaving a row behind.
async function refuse(sql, ctx, code, message, detail = {}) {
    await recordRejection(sql, ctx, code, message);
    return err(code, message, detail);
}

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

// The gateway submit pipeline (design §7): AuthN → membership → effectiveAccess
// → quota+reservation → enqueue → 202. Shared by /api/generations POST (image +
// generic requests) and the MCP create_image tool. Callers must validate
// presence of projectId/modelId/request themselves before calling this.
export async function enqueueGeneration({ user, projectId, modelId, request, options = null, priority = 'interactive' }) {
    const auth = await gatewayContextFor(user, { projectId, permission: 'generation.create' });
    if (!auth.ok) {
        const body = await auth.response.json().catch(() => ({}));
        return { status: auth.response.status, body, enqueued: false };
    }
    const { sql, project } = auth.ctx;

    // What a refusal knows about the attempt. Refined as the pipeline learns
    // more, so a late refusal records the sanitized body and resolved version
    // rather than the raw request.
    const ctx = {
        projectId: project.id, userId: user.userId, modelId, priority,
        requestBody: request, modelVersionId: null,
    };

    if (project.paused) return refuse(sql, ctx, 'PROJECT_PAUSED', 'This project is paused by an admin.');
    if (await queuedDepth(sql, project.id) >= QUEUE_DEPTH_CAP) {
        return refuse(sql, ctx, 'QUEUE_FULL', `Project queue is full (${QUEUE_DEPTH_CAP} pending).`);
    }

    const rows = await accessRows(sql, project.id, user.userId);
    const decision = effectiveAccess({ modelId, now: new Date(), ...rows });
    if (!decision.allowed) {
        return refuse(sql, ctx, 'MODEL_ACCESS_DENIED', 'You do not have access to this model.', { rule: decision.rule });
    }

    const routing = await resolveRouting(sql, modelId);
    if (!routing) return refuse(sql, ctx, 'BAD_REQUEST', 'Unknown or inactive model.');
    ctx.modelVersionId = routing.version.id;
    const route = routing.routes[0] || {};

    // Image requests are sanitized at the boundary: require a prompt, normalize
    // reference-image parts (image-only, ≤3, size-capped, strip data: prefix),
    // and clamp imageCount so it can't inflate the cost reservation. The video
    // path keeps its own client+server validation and is untouched here.
    let requestBody = request;
    // Normalize once: options may be null/undefined (both flow the same way
    // as the route's original body.options, which callers often omit
    // entirely) — estimateFor's own `options = {}` default only fires for
    // undefined, so a bare null would otherwise reach `options.resolution`
    // unguarded for non-image categories.
    let resolvedOptions = options || {};
    if (routing.model.category === 'image') {
        const clean = sanitizeImageRequest(request, options, imageRefMax(modelId));
        if (clean.error) return refuse(sql, ctx, 'BAD_REQUEST', clean.error);
        requestBody = clean.request;
        ctx.requestBody = clean.request;
        resolvedOptions = {
            ...(options || {}),
            imageCount: clean.imageCount,
            aspectRatio: clean.aspectRatio,
            imageSize: clean.imageSize,
        };
    }

    // A granted model may still be quality-capped by the admin's approval
    // (maxResolution on the allow override; the deploy backfill caps every
    // legacy grant at 2K/1080p — 4K is request-only). Checked after image
    // sanitize so the comparison sees the clean imageSize.
    const tierLadder = routing.model.category === 'image' ? IMAGE_RESOLUTIONS : RESOLUTIONS;
    const requestedTier = routing.model.category === 'image' ? resolvedOptions.imageSize : resolvedOptions.resolution;
    if (!resolutionWithinTier(requestedTier, decision.maxResolution, tierLadder)) {
        return refuse(sql, ctx, 'MODEL_ACCESS_DENIED', `Your access covers up to ${decision.maxResolution} on this model — request ${requestedTier} access.`, { rule: 'resolution_cap' });
    }

    const estimate = estimateFor({
        category: routing.model.category, kind: routing.version.kind, mode: route.mode, options: resolvedOptions,
    });

    const quotas = await activeQuotas(sql);
    const usage = await usageForQuotas(sql, quotas);
    const verdict = evaluateQuotas({
        quotas, projectId: project.id, userId: user.userId, modelId, now: new Date(), estimate, ...usage,
    });
    if (!verdict.ok) {
        const v = verdict.violations[0];
        return refuse(sql, ctx, 'QUOTA_EXCEEDED', 'A budget or quota limit would be exceeded.', {
            limit: { type: v.quota.type, window: v.quota.window, amount: Number(v.quota.hard_limit), scope: v.quota.model_id ? 'model' : v.quota.user_id ? 'user' : v.quota.project_id ? 'project' : 'workspace', model_id: v.quota.model_id ?? null },
            resets_at: v.resetsAt,
        });
    }

    const job = await insertJob(sql, {
        projectId: project.id, userId: user.userId, modelId,
        modelVersionId: routing.version.id, priority: priority === 'batch' ? 'batch' : 'interactive',
        status: 'reserving',
        requestBody: { ...requestBody, options: resolvedOptions ?? null, est_cost_usd: estimate.usd, category: routing.model.category },
    });
    let reservation;
    try {
        reservation = await reserveBillingEvent(sql, {
            eventType: 'reservation', generationId: job.id, projectId: project.id,
            userId: user.userId, modelId, modelVersionId: routing.version.id,
            units: { images: estimate.images || null, video_seconds: estimate.video_seconds || null },
            estCostUsd: estimate.usd, pricingSnapshot: { basis: 'estimate' },
        });
    } catch (error) {
        try { await sql`DELETE FROM jobs WHERE id = ${job.id} AND status = 'reserving'`; } catch { /* best-effort cleanup */ }
        throw error;
    }
    if (!reservation) {
        // The row already exists, so retire it in place rather than deleting
        // it: a deleted row is a refusal with no trace, which is the gap the
        // `rejected` status closes everywhere else in this function. Nothing
        // ever claims a rejected job — processQueue only takes `queued`.
        await sql`UPDATE jobs SET status = 'rejected', finished_at = now(),
                error = ${JSON.stringify({ code: 'QUOTA_EXCEEDED', message: 'A budget or quota limit would be exceeded.' })}
            WHERE id = ${job.id} AND status = 'reserving'`;
        return err('QUOTA_EXCEEDED', 'A budget or quota limit would be exceeded.');
    }
    await sql`UPDATE jobs SET status = 'queued' WHERE id = ${job.id} AND status = 'reserving'`;
    await emitEvent(sql, { projectId: project.id, userId: user.userId, type: 'job.status_changed', payload: { jobId: job.id, status: 'queued' } });

    return { status: 202, body: { generationId: job.id, status: 'queued', estCostUsd: estimate.usd }, enqueued: true };
}
