import { NextResponse } from 'next/server';
import { gatewayContext, clientIp } from '../../../../lib/gateway/authz.js';
import { apiError } from '../../../../lib/gateway/httpError.mjs';
import { modelUsageForQuotas, writeAudit, usageForQuotas } from '../../../../lib/gateway/db.js';

export const runtime = 'nodejs';

const TYPES = ['usd', 'credits', 'image_count', 'video_seconds', 'request_count'];
const WINDOWS = ['daily', 'monthly', 'lifetime'];

export async function GET(request) {
    const auth = await gatewayContext({ permission: 'quota.manage' });
    if (!auth.ok) return auth.response;
    const { sql } = auth.ctx;
    const url = new URL(request.url);
    const rawProjectId = url.searchParams.get('projectId');
    const projectId = rawProjectId == null ? null : Number(rawProjectId);
    if (rawProjectId != null && (!Number.isInteger(projectId) || projectId <= 0)) {
        return apiError('BAD_REQUEST', 'projectId must be a positive integer.');
    }
    const items = await sql`SELECT q.*, p.name AS project_name, m.display_name AS model_name FROM quotas q
        LEFT JOIN projects p ON p.id = q.project_id
        LEFT JOIN models m ON m.id = q.model_id
        WHERE q.deleted_at IS NULL
          AND (${projectId}::int IS NULL OR q.project_id = ${projectId})
        ORDER BY q.created_at DESC`;
    const models = await sql`SELECT id, display_name, category FROM models WHERE active = true
        ORDER BY category, display_name`;
    if (url.searchParams.get('withUsage')) {
        const { usedByQuota, reservedByQuota } = await usageForQuotas(sql, items);
        const breakdownByQuota = url.searchParams.get('withModelBreakdown')
            ? await modelUsageForQuotas(sql, items)
            : {};
        return NextResponse.json({
            items: items.map((q) => ({
                ...q,
                used: usedByQuota[q.id] ?? 0,
                reserved: reservedByQuota[q.id] ?? 0,
                ...(url.searchParams.get('withModelBreakdown')
                    ? { model_breakdown: breakdownByQuota[q.id] ?? [] }
                    : {}),
            })),
            models,
        });
    }
    return NextResponse.json({ items, models });
}

export async function POST(request) {
    const auth = await gatewayContext({ permission: 'quota.manage' });
    if (!auth.ok) return auth.response;
    const { sql, user } = auth.ctx;
    const b = await request.json().catch(() => null);
    if (!b || !TYPES.includes(b.type) || !WINDOWS.includes(b.window) || !(Number(b.hardLimit) > 0)) {
        return apiError('BAD_REQUEST', `type (${TYPES.join('|')}), window (${WINDOWS.join('|')}) and hardLimit > 0 are required.`);
    }
    const modelId = typeof b.modelId === 'string' && b.modelId.trim() ? b.modelId.trim() : null;
    if (modelId) {
        const [model] = await sql`SELECT id FROM models WHERE id = ${modelId} AND active = true`;
        if (!model) return apiError('BAD_REQUEST', 'modelId must identify an active model.');
    }
    const [quota] = await sql`INSERT INTO quotas
        (project_id, user_id, model_id, type, "window", hard_limit, policy, soft_overage_pct, alert_thresholds, created_by)
        VALUES (${b.projectId ?? null}, ${b.userId ?? null}, ${modelId}, ${b.type}, ${b.window}, ${Number(b.hardLimit)},
                ${b.policy === 'soft' ? 'soft' : 'hard'}, ${Number(b.softOveragePct) || 5},
                ${Array.isArray(b.alertThresholds) && b.alertThresholds.length ? b.alertThresholds.map(Number) : [80, 90, 100]}, ${user.userId})
        RETURNING *`;
    await writeAudit(sql, {
        actorId: user.userId, actorEmail: user.email, action: 'quota.create',
        targetType: 'quota', targetId: quota.id, after: quota, ip: clientIp(request),
    });
    return NextResponse.json(quota, { status: 201 });
}

export async function DELETE(request) {
    const auth = await gatewayContext({ permission: 'quota.manage' });
    if (!auth.ok) return auth.response;
    const { sql, user } = auth.ctx;
    const id = Number(new URL(request.url).searchParams.get('id'));
    if (!id) return apiError('BAD_REQUEST', 'id query param required.');
    const [quota] = await sql`UPDATE quotas SET deleted_at = now()
        WHERE id = ${id} AND deleted_at IS NULL RETURNING *`;
    if (!quota) return apiError('NOT_FOUND', 'Quota not found.');
    await writeAudit(sql, {
        actorId: user.userId, actorEmail: user.email, action: 'quota.delete',
        targetType: 'quota', targetId: id, before: quota, ip: clientIp(request),
    });
    return NextResponse.json({ ok: true });
}
