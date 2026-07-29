import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../lib/gateway/authz.js';
import { activeQuotas, usageForQuotas } from '../../../../lib/gateway/db.js';
import { applicableQuotas, quotaBalances, windowBounds } from '../../../../lib/gateway/quota.mjs';
import { apiError } from '../../../../lib/gateway/httpError.mjs';

export const runtime = 'nodejs';

export async function GET(request) {
    const url = new URL(request.url);
    const projectId = Number(url.searchParams.get('projectId')) || null;
    if (!projectId) return apiError('BAD_REQUEST', 'projectId is required.');

    const auth = await gatewayContext({ projectId });
    if (!auth.ok) return auth.response;
    const { sql, user } = auth.ctx;

    const requestedModelId = url.searchParams.get('modelId')?.trim() || null;
    let modelId = null;
    if (requestedModelId) {
        const [model] = await sql`SELECT DISTINCT m.id FROM models m
            LEFT JOIN model_versions v ON v.model_id = m.id
            WHERE m.active = true AND (m.id = ${requestedModelId} OR v.version_tag = ${requestedModelId})
            LIMIT 1`;
        modelId = model?.id ?? requestedModelId;
    }

    const quotas = applicableQuotas(await activeQuotas(sql), {
        projectId,
        userId: user.userId,
        modelId,
    }).filter((quota) => quota.type === 'usd');
    const usage = await usageForQuotas(sql, quotas);
    const balances = quotaBalances({
        quotas,
        projectId,
        userId: user.userId,
        modelId,
        ...usage,
    });
    const binding = balances[0];
    if (!binding) return NextResponse.json({ budget: null });

    const { quota, limit, used, reserved, remaining } = binding;
    const scope = quota.user_id && quota.model_id
        ? 'your model budget'
        : quota.user_id
            ? 'your budget'
            : quota.model_id
                ? 'model budget'
                : quota.project_id
                    ? 'project budget'
                    : 'workspace budget';

    return NextResponse.json({
        budget: {
            remaining,
            limit,
            used,
            reserved,
            window: quota.window,
            scope,
            modelId: quota.model_id ?? null,
            resetsAt: windowBounds(quota.window, new Date()).resetsAt?.toISOString() ?? null,
        },
    });
}
