// Server-only: access + budget for tool jobs that run on the exr_jobs queue.
// Same ledger as generations (billing_events), so spend dashboards, rollups,
// /api/budgets/me and quota enforcement all see tool spend.
//
// generation_id is an integer column shared with gateway `jobs.id`; tool jobs
// write the NEGATED exr_jobs.id so the two id spaces can never close each
// other's reservations or join into the generation ledger view.

import { effectiveAccess } from '../gateway/access.mjs';
import { activeQuotas, reserveBillingEvent, usageForQuotas } from '../gateway/db.js';
import { applicableQuotas } from '../gateway/quota.mjs';

export const toolGenerationId = (exrJobId) => -Math.abs(Number(exrJobId));

async function accessFor(sql, { projectId, userId, toolId }) {
    const grants = await sql`SELECT * FROM project_model_grants WHERE project_id = ${projectId}`;
    const overrides = await sql`SELECT * FROM user_model_overrides WHERE project_id = ${projectId} AND user_id = ${userId}`;
    const defaultModelIds = (await sql`SELECT id FROM models WHERE is_default = true AND active = true`).map((m) => m.id);
    return effectiveAccess({ modelId: toolId, now: new Date(), grants, overrides, defaultModelIds });
}

async function requestStatus(sql, { projectId, userId, toolId }) {
    const [row] = await sql`SELECT status FROM model_access_requests
        WHERE user_id = ${userId} AND model_id = ${toolId} AND project_id = ${projectId}
        ORDER BY created_at DESC LIMIT 1`;
    return row?.status || null;
}

// The tightest USD headroom across every budget that covers this tool spend.
// A tool-scoped budget (model_id = toolId) is REQUIRED: without one the tool is
// unusable, even when a broader workspace/project budget exists — nobody runs
// a tool unlimited.
async function budgetFor(sql, { projectId, userId, toolId }) {
    const all = await activeQuotas(sql);
    const applicable = applicableQuotas(all, { projectId, userId, modelId: toolId });
    if (!applicable.some((q) => q.model_id === toolId)) return null;
    const usd = applicable.filter((q) => q.type === 'usd');
    const { usedByQuota, reservedByQuota } = await usageForQuotas(sql, usd);
    let tightest = null;
    for (const q of usd) {
        const limit = Number(q.hard_limit);
        const remaining = limit - Number(usedByQuota[q.id] || 0) - Number(reservedByQuota[q.id] || 0);
        if (!tightest || remaining < tightest.remainingUsd) tightest = { limitUsd: limit, remainingUsd: Math.max(0, remaining) };
    }
    return tightest || { limitUsd: null, remainingUsd: null }; // tool budget exists but is non-USD
}

export async function toolStatus(sql, { projectId, userId, toolId }) {
    const [decision, status, budget] = await Promise.all([
        accessFor(sql, { projectId, userId, toolId }),
        requestStatus(sql, { projectId, userId, toolId }),
        budgetFor(sql, { projectId, userId, toolId }),
    ]);
    return { allowed: decision.allowed, requestStatus: status, budget };
}

// → reservation row or null when a budget would be exceeded.
export function reserveToolSpend(sql, { exrJobId, projectId, userId, toolId, seconds, estCostUsd }) {
    return reserveBillingEvent(sql, {
        eventType: 'reservation', generationId: toolGenerationId(exrJobId), projectId, userId, modelId: toolId,
        units: { video_seconds: seconds || null }, estCostUsd, pricingSnapshot: { basis: 'estimate', tool: toolId },
    });
}

// Close a tool job's reservation exactly once, whatever path finishes it
// (worker success/failure, admin cancel, re-archive re-running the finish).
// outcome: 'settlement' (costUsd = actual) | 'failure' | 'release'.
export async function closeToolSpend(sql, job, outcome, { costUsd = null, seconds = null } = {}) {
    const toolId = job?.request_body?._billing?.toolId;
    if (!toolId) return; // EXR jobs: not budgeted here (yet)
    const gid = toolGenerationId(job.id);
    await sql`INSERT INTO billing_events
        (event_type, generation_id, project_id, user_id, model_id, units, est_cost_usd, cost_usd, pricing_snapshot)
        SELECT ${outcome}, ${gid}, ${job.project_id}, ${job.user_id}, ${toolId},
               ${JSON.stringify({ video_seconds: seconds })}, ${job.request_body._billing.estimatedCostUsd ?? null},
               ${outcome === 'settlement' ? costUsd : null},
               ${JSON.stringify({ basis: outcome === 'settlement' ? 'provider_duration' : outcome, tool: toolId })}
        WHERE NOT EXISTS (SELECT 1 FROM billing_events
            WHERE generation_id = ${gid} AND event_type IN ('settlement', 'failure', 'release'))`;
}
