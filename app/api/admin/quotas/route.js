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
    if (['image_count', 'request_count'].includes(b.type) && !Number.isInteger(Number(b.hardLimit))) {
        return apiError('BAD_REQUEST', `${b.type} budgets require a whole-number cap.`);
    }
    const modelId = typeof b.modelId === 'string' && b.modelId.trim() ? b.modelId.trim() : null;
    if (modelId) {
        const [model] = await sql`SELECT id FROM models WHERE id = ${modelId} AND active = true`;
        if (!model) return apiError('BAD_REQUEST', 'modelId must identify an active model.');
    }
    // The active-scope unique index makes this safe under concurrent requests:
    // if another admin creates the same scope after the preview loaded, this
    // statement adds to that row instead of creating a second binding quota.
    const [result] = await sql`INSERT INTO quotas
        (project_id, user_id, model_id, type, "window", hard_limit, policy, soft_overage_pct, alert_thresholds, created_by)
        VALUES (${b.projectId ?? null}, ${b.userId ?? null}, ${modelId}, ${b.type}, ${b.window}, ${Number(b.hardLimit)},
                ${b.policy === 'soft' ? 'soft' : 'hard'}, ${Number(b.softOveragePct) || 5},
                ${Array.isArray(b.alertThresholds) && b.alertThresholds.length ? b.alertThresholds.map(Number) : [80, 90, 100]}, ${user.userId})
        ON CONFLICT (
            (COALESCE(project_id, -1)),
            (COALESCE(user_id, '')),
            (COALESCE(model_id, '')),
            type,
            "window"
        ) WHERE deleted_at IS NULL
        DO UPDATE SET hard_limit = quotas.hard_limit + EXCLUDED.hard_limit
        RETURNING *, (xmax = 0) AS inserted`;
    const { inserted, ...quota } = result;
    const wasInserted = inserted === true;
    const before = wasInserted ? null : { ...quota, hard_limit: Number(quota.hard_limit) - Number(b.hardLimit) };
    await writeAudit(sql, {
        actorId: user.userId,
        actorEmail: user.email,
        action: wasInserted ? 'quota.create' : 'quota.top_up',
        targetType: 'quota',
        targetId: quota.id,
        before,
        after: quota,
        ip: clientIp(request),
    });
    return NextResponse.json({ ...quota, created: wasInserted }, { status: wasInserted ? 201 : 200 });
}

// Add capacity to an existing budget atomically. This is intentionally an
// increment rather than an absolute replacement so two admins topping up at
// the same time cannot silently overwrite one another.
export async function PATCH(request) {
    const auth = await gatewayContext({ permission: 'quota.manage' });
    if (!auth.ok) return auth.response;
    const { sql, user } = auth.ctx;
    const body = await request.json().catch(() => null);
    const id = Number(body?.id);
    if (!Number.isInteger(id) || id <= 0) {
        return apiError('BAD_REQUEST', 'A valid budget id is required.');
    }

    const [before] = await sql`SELECT * FROM quotas WHERE id = ${id} AND deleted_at IS NULL`;
    if (!before) return apiError('NOT_FOUND', 'Budget not found.');

    // Absolute cap correction. Scope, type, window and policy deliberately stay
    // immutable here; this action only repairs an accidental allocation.
    if (body?.newHardLimit != null) {
        const newHardLimit = Number(body.newHardLimit);
        const expectedHardLimit = Number(body.expectedHardLimit);
        const currentHardLimit = Number(before.hard_limit);
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (!Number.isFinite(newHardLimit) || !(newHardLimit > 0) || !Number.isFinite(expectedHardLimit)) {
            return apiError('BAD_REQUEST', 'newHardLimit > 0 and expectedHardLimit are required.');
        }
        if (['image_count', 'request_count'].includes(before.type) && !Number.isInteger(newHardLimit)) {
            return apiError('BAD_REQUEST', `${before.type} budgets require a whole-number cap.`);
        }

        const { usedByQuota, reservedByQuota } = await usageForQuotas(sql, [before]);
        const used = Number(usedByQuota[id] ?? 0);
        const reserved = Number(reservedByQuota[id] ?? 0);
        const minimumHardLimit = used + reserved;
        const snapshot = { currentHardLimit, used, reserved, minimumHardLimit };

        if (currentHardLimit !== expectedHardLimit) {
            return apiError('BUDGET_CONFLICT', 'This budget was changed by another admin. Review the latest values and try again.', snapshot);
        }
        if (newHardLimit < minimumHardLimit) {
            return apiError('BUDGET_CAP_TOO_LOW', 'The cap cannot be lower than spent plus in-flight usage.', snapshot);
        }
        if (newHardLimit === currentHardLimit) {
            return apiError('BAD_REQUEST', 'The new cap must differ from the current cap.');
        }
        if (newHardLimit < currentHardLimit && reason.length < 3) {
            return apiError('BAD_REQUEST', 'A short reason is required when reducing a budget.');
        }
        if (reason.length > 500) {
            return apiError('BAD_REQUEST', 'The reason must be 500 characters or fewer.');
        }

        const [quota] = await sql`UPDATE quotas
            SET hard_limit = ${newHardLimit}
            WHERE id = ${id} AND deleted_at IS NULL AND hard_limit = ${expectedHardLimit}
            RETURNING *`;
        if (!quota) {
            const [current] = await sql`SELECT hard_limit FROM quotas WHERE id = ${id} AND deleted_at IS NULL`;
            if (!current) return apiError('NOT_FOUND', 'Budget not found.');
            return apiError('BUDGET_CONFLICT', 'This budget changed while you were saving. Refresh and try again.', {
                ...snapshot,
                currentHardLimit: Number(current.hard_limit),
            });
        }
        await writeAudit(sql, {
            actorId: user.userId,
            actorEmail: user.email,
            action: 'quota.cap_changed',
            targetType: 'quota',
            targetId: id,
            before,
            after: { ...quota, usage_at_change: { used, reserved, minimum_hard_limit: minimumHardLimit } },
            reason: reason || null,
            ip: clientIp(request),
        });
        return NextResponse.json({ ...quota, used, reserved });
    }

    const addAmount = Number(body?.addAmount);
    if (!(addAmount > 0) || !Number.isFinite(addAmount)) {
        return apiError('BAD_REQUEST', 'addAmount > 0 is required.');
    }
    if (['image_count', 'request_count'].includes(before.type) && !Number.isInteger(addAmount)) {
        return apiError('BAD_REQUEST', `${before.type} budgets require a whole-number amount.`);
    }
    const [quota] = await sql`UPDATE quotas
        SET hard_limit = hard_limit + ${addAmount}
        WHERE id = ${id} AND deleted_at IS NULL
        RETURNING *`;
    if (!quota) return apiError('NOT_FOUND', 'Budget not found.');
    await writeAudit(sql, {
        actorId: user.userId,
        actorEmail: user.email,
        action: 'quota.top_up',
        targetType: 'quota',
        targetId: id,
        before,
        after: quota,
        ip: clientIp(request),
    });
    return NextResponse.json(quota);
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
