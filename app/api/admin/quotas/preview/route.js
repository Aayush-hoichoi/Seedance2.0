import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../../lib/gateway/authz.js';
import { apiError } from '../../../../../lib/gateway/httpError.mjs';
import { usageForQuotas } from '../../../../../lib/gateway/db.js';

export const runtime = 'nodejs';

const TYPES = ['usd', 'credits', 'image_count', 'video_seconds', 'request_count'];
const WINDOWS = ['daily', 'monthly', 'lifetime'];

// Current usage for an unsaved budget scope. The Add Budget dialog uses this
// instead of estimating spend in the browser, so its preview matches the same
// billing-event calculation used to enforce a saved quota.
export async function GET(request) {
    const auth = await gatewayContext({ permission: 'quota.manage' });
    if (!auth.ok) return auth.response;

    const { sql } = auth.ctx;
    const params = new URL(request.url).searchParams;
    const projectId = Number(params.get('projectId'));
    const type = params.get('type') || 'usd';
    const window = params.get('window') || 'monthly';
    const userId = params.get('userId')?.trim() || null;
    const modelId = params.get('modelId')?.trim() || null;

    if (!Number.isInteger(projectId) || projectId <= 0) {
        return apiError('BAD_REQUEST', 'projectId must be a positive integer.');
    }
    if (!TYPES.includes(type) || !WINDOWS.includes(window)) {
        return apiError('BAD_REQUEST', 'A valid budget type and window are required.');
    }

    const [project] = await sql`SELECT id, name FROM projects WHERE id = ${projectId} AND archived_at IS NULL`;
    if (!project) return apiError('NOT_FOUND', 'Project not found.');

    let user = null;
    if (userId) {
        [user] = await sql`SELECT u.id, u.email, u.name
            FROM users u
            JOIN project_memberships pm ON pm.user_id = u.id
            WHERE u.id = ${userId} AND pm.project_id = ${projectId}`;
        if (!user) return apiError('BAD_REQUEST', 'User must be a member of this project.');
    }

    let model = null;
    if (modelId) {
        [model] = await sql`SELECT id, display_name, category FROM models WHERE id = ${modelId} AND active = true`;
        if (!model) return apiError('BAD_REQUEST', 'Model must be active.');
    }

    const [existingBudget] = await sql`SELECT id, hard_limit, policy, soft_overage_pct
        FROM quotas
        WHERE deleted_at IS NULL
          AND project_id = ${projectId}
          AND user_id IS NOT DISTINCT FROM ${userId}
          AND model_id IS NOT DISTINCT FROM ${modelId}
          AND type = ${type}
          AND "window" = ${window}
        ORDER BY created_at DESC
        LIMIT 1`;

    const previewQuota = {
        id: 'preview',
        project_id: projectId,
        user_id: userId,
        model_id: modelId,
        type,
        window,
    };
    const { usedByQuota, reservedByQuota } = await usageForQuotas(sql, [previewQuota]);
    const used = usedByQuota.preview ?? 0;
    const reserved = reservedByQuota.preview ?? 0;
    const existingHardLimit = existingBudget ? Number(existingBudget.hard_limit) : 0;
    // Keep the relationship explicit for the UI: previously allotted is the
    // amount already spent plus what remains on the existing budget. Remaining
    // may be negative after a soft-budget overage, preserving the original cap.
    const remaining = existingBudget ? existingHardLimit - used : 0;
    const previouslyAllotted = existingBudget ? used + remaining : 0;

    return NextResponse.json({
        project,
        user: user || { id: null, email: 'Everyone', name: 'Everyone' },
        model,
        type,
        window,
        used,
        reserved,
        remaining,
        previouslyAllotted,
        existingBudget: existingBudget ? {
            id: existingBudget.id,
            hardLimit: existingHardLimit,
            policy: existingBudget.policy,
            softOveragePct: Number(existingBudget.soft_overage_pct),
        } : null,
    });
}
