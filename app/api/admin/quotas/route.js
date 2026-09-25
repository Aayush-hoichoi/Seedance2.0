import { NextResponse } from 'next/server';
import { gatewayContext, clientIp } from '../../../../lib/gateway/authz.js';
import { apiError } from '../../../../lib/gateway/httpError.mjs';
import { resolvePolicyEdit } from '../../../../lib/gateway/quota.mjs';
import { changeQuotaCapSafely, changeQuotaScopeSafely, modelUsageForQuotas, overCommitsProject, projectAllocation, writeAudit, usageForQuotas } from '../../../../lib/gateway/db.js';

export const runtime = 'nodejs';

const TYPES = ['usd', 'credits', 'image_count', 'video_seconds', 'request_count'];
const WINDOWS = ['daily', 'monthly', 'lifetime'];
const POLICIES = ['hard', 'soft'];

const usd = (n) => `$${Number(n).toFixed(2)}`;

// Member budgets are carved out of the project's overall budget, so one that
// would push the allotted total past it is refused rather than silently
// over-committing the project.
function overCommitError(v) {
    return apiError('BUDGET_EXCEEDS_PROJECT_CAP',
        `This exceeds the project's overall budget of ${usd(v.overallCap)}. Members are already allotted ${usd(v.allocated)}, leaving ${usd(v.available)} — raise the overall budget first.`,
        v);
}

// The overall budget row itself: everyone, all models, USD, lifetime.
const isOverallBudget = (q) => q.project_id != null && !q.user_id && !q.model_id
    && q.type === 'usd' && q.window === 'lifetime';

export async function GET(request) {
    const auth = await gatewayContext({ permission: 'quota.manage' });
    if (!auth.ok) return auth.response;
    const { sql } = auth.ctx;
    const url = new URL(request.url);
    const rawHistoryFor = url.searchParams.get('historyFor');
    if (rawHistoryFor != null) {
        const quotaId = Number(rawHistoryFor);
        if (!Number.isInteger(quotaId) || quotaId <= 0) {
            return apiError('BAD_REQUEST', 'historyFor must be a positive integer.');
        }
        // Budget change history straight from the audit trail — every cap
        // change already writes a row there, so nothing new is recorded.
        const items = await sql`SELECT created_at, actor_id, actor_email, action, before, after, reason
            FROM audit_log
            WHERE target_type = 'quota' AND target_id = ${String(quotaId)}
            ORDER BY created_at DESC LIMIT 100`;
        return NextResponse.json({ items });
    }
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
    if (b.projectId != null && b.window !== 'lifetime') {
        return apiError('BAD_REQUEST', 'Project budgets must use the lifetime window.');
    }
    const modelId = typeof b.modelId === 'string' && b.modelId.trim() ? b.modelId.trim() : null;
    if (b.userId && !modelId) {
        return apiError('BAD_REQUEST', 'Per-user budgets must name a specific model — all-models budgets for a user are disabled.');
    }
    if (modelId) {
        const [model] = await sql`SELECT id FROM models WHERE id = ${modelId} AND active = true`;
        if (!model) return apiError('BAD_REQUEST', 'modelId must identify an active model.');
    }
    // The upsert below ADDS to any existing budget for this scope, so the
    // amount asked for is the delta against the project's allotted total.
    const overCommit = await overCommitsProject(sql, {
        projectId: b.projectId ?? null, userId: b.userId ?? null, type: b.type, window: b.window,
        nextLimit: Number(b.hardLimit),
    });
    if (overCommit) return overCommitError(overCommit);
    // Setting the overall budget for the first time has the mirror constraint:
    // it cannot open below the member budgets already carved out of it.
    if (isOverallBudget({ project_id: b.projectId ?? null, user_id: b.userId ?? null, model_id: modelId, type: b.type, window: b.window })) {
        const { overallCap, allocated } = await projectAllocation(sql, b.projectId);
        const resulting = (overallCap ?? 0) + Number(b.hardLimit);
        if (resulting < allocated) {
            return apiError('BUDGET_BELOW_ALLOCATIONS',
                `Members of this project are already allotted ${usd(allocated)}. The overall budget must be at least that much — ${usd(resulting)} would strand budgets that are already in use.`,
                { allocated, requested: resulting });
        }
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

    // Model-scope change (widen to all models, or move/narrow to one model).
    // Usage re-attributes itself from billing_events on the next read, so a
    // widened budget can wake up over-cap — that is by design; the console
    // previews the jump before saving. Narrowing frees headroom, so it needs a
    // reason, like cap reductions below.
    if (Object.hasOwn(body, 'newModelId')) {
        if (!Object.hasOwn(body, 'expectedModelId')) {
            return apiError('BAD_REQUEST', 'expectedModelId is required (null means all models).');
        }
        const newModelId = typeof body.newModelId === 'string' && body.newModelId.trim() ? body.newModelId.trim() : null;
        const expectedModelId = typeof body.expectedModelId === 'string' && body.expectedModelId.trim() ? body.expectedModelId.trim() : null;
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if ((before.model_id ?? null) !== expectedModelId) {
            return apiError('BUDGET_CONFLICT', 'This budget was changed by another admin. Review the latest values and try again.', {
                currentModelId: before.model_id ?? null,
            });
        }
        if ((before.model_id ?? null) === newModelId) {
            return apiError('BAD_REQUEST', 'The new model scope must differ from the current scope.');
        }
        if (before.user_id && !newModelId) {
            return apiError('BAD_REQUEST', 'A per-user budget cannot be widened to all models — all-models budgets for a user are disabled.');
        }
        if (newModelId) {
            const [model] = await sql`SELECT id FROM models WHERE id = ${newModelId} AND active = true`;
            if (!model) return apiError('BAD_REQUEST', 'newModelId must identify an active model.');
            if (reason.length < 3) {
                return apiError('BAD_REQUEST', 'A short reason is required when scoping a budget to one model — it frees the other models\' spend.');
            }
        }
        if (reason.length > 500) {
            return apiError('BAD_REQUEST', 'The reason must be 500 characters or fewer.');
        }
        // Widening an everyone budget to all models turns it INTO the project's
        // overall budget, so its cap has to clear what members already hold.
        if (isOverallBudget({ ...before, model_id: newModelId })) {
            const { allocated } = await projectAllocation(sql, before.project_id);
            if (Number(before.hard_limit) < allocated) {
                return apiError('BUDGET_BELOW_ALLOCATIONS',
                    `Widening this to all models makes it the project's overall budget, but members are already allotted ${usd(allocated)} — more than its ${usd(before.hard_limit)} cap.`,
                    { allocated, requested: Number(before.hard_limit) });
            }
        }

        // Usage under both scopes, recorded in the audit row: the permanent
        // explanation of why this budget's "used" figure jumped or dropped.
        const { usedByQuota, reservedByQuota } = await usageForQuotas(sql, [
            { ...before, id: 'old' },
            { ...before, id: 'new', model_id: newModelId },
        ]);
        const usage = {
            before: { used: usedByQuota.old ?? 0, reserved: reservedByQuota.old ?? 0 },
            after: { used: usedByQuota.new ?? 0, reserved: reservedByQuota.new ?? 0 },
        };

        let quota;
        try {
            quota = await changeQuotaScopeSafely(sql, {
                id, newModelId, before, actor: user, reason: reason || null, ip: clientIp(request), usage,
            });
        } catch (error) {
            // The unique active-scope index can still fire if another flow that
            // does not take the scope advisory locks (e.g. POST upsert) inserts
            // the target scope concurrently.
            if (error?.code === '23505' || /duplicate key/i.test(error?.message || '')) {
                return apiError('SCOPE_CONFLICT', 'A budget already covers that scope — top it up or delete it first.');
            }
            throw error;
        }
        if (!quota) {
            const [current] = await sql`SELECT * FROM quotas WHERE id = ${id} AND deleted_at IS NULL`;
            if (!current) return apiError('NOT_FOUND', 'Budget not found.');
            if ((current.model_id ?? null) !== expectedModelId) {
                return apiError('BUDGET_CONFLICT', 'This budget was changed by another admin. Review the latest values and try again.', {
                    currentModelId: current.model_id ?? null,
                });
            }
            const [colliding] = await sql`SELECT id, hard_limit FROM quotas
                WHERE id <> ${id} AND deleted_at IS NULL
                  AND project_id IS NOT DISTINCT FROM ${current.project_id}
                  AND user_id IS NOT DISTINCT FROM ${current.user_id}
                  AND model_id IS NOT DISTINCT FROM ${newModelId}
                  AND type = ${current.type} AND "window" = ${current.window}`;
            if (colliding) {
                return apiError('SCOPE_CONFLICT', 'A budget already covers that scope — top it up or delete it first.', {
                    existingBudgetId: colliding.id, existingHardLimit: Number(colliding.hard_limit),
                });
            }
            return apiError('BUDGET_CONFLICT', 'This budget changed while you were saving. Refresh and try again.');
        }
        return NextResponse.json({ ...quota, used: usage.after.used, reserved: usage.after.reserved });
    }

    // Absolute cap correction, and the enforcement policy that goes with it:
    // hard rejects at the limit, soft allows the overage %. Type and window stay
    // immutable here; model scope changes go through the newModelId branch above.
    if (body?.newHardLimit != null) {
        const newHardLimit = Number(body.newHardLimit);
        const expectedHardLimit = Number(body.expectedHardLimit);
        const currentHardLimit = Number(before.hard_limit);
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (!Number.isFinite(newHardLimit) || newHardLimit < 0 || !Number.isFinite(expectedHardLimit)) {
            return apiError('BAD_REQUEST', 'newHardLimit >= 0 and expectedHardLimit are required.');
        }
        if (['image_count', 'request_count'].includes(before.type) && !Number.isInteger(newHardLimit)) {
            return apiError('BAD_REQUEST', `${before.type} budgets require a whole-number cap.`);
        }
        const edit = resolvePolicyEdit(body, before);
        if (edit.error === 'policy') {
            return apiError('BAD_REQUEST', `newPolicy must be one of ${POLICIES.join('|')}.`);
        }
        if (edit.error === 'overage') {
            return apiError('BAD_REQUEST', 'newSoftOveragePct must be a whole number between 1 and 50.');
        }
        const { policy: newPolicy, softOveragePct: newSoftOveragePct, changed: policyChanged } = edit;

        if (currentHardLimit !== expectedHardLimit) {
            return apiError('BUDGET_CONFLICT', 'This budget was changed by another admin. Review the latest values and try again.', {
                currentHardLimit,
            });
        }
        if (newHardLimit === currentHardLimit && !policyChanged) {
            return apiError('BAD_REQUEST', 'Change the cap or the policy — nothing here differs from the current budget.');
        }
        if (newHardLimit < currentHardLimit && reason.length < 3) {
            return apiError('BAD_REQUEST', 'A short reason is required when reducing a budget.');
        }
        if (reason.length > 500) {
            return apiError('BAD_REQUEST', 'The reason must be 500 characters or fewer.');
        }
        // Raising a member budget must stay inside the project's overall
        // budget; lowering the overall budget must not strand the member
        // budgets already carved out of it. Same invariant, both directions.
        if (isOverallBudget(before)) {
            const { allocated } = await projectAllocation(sql, before.project_id);
            if (newHardLimit < allocated) {
                return apiError('BUDGET_BELOW_ALLOCATIONS',
                    `Members are already allotted ${usd(allocated)} of this project. Reduce their budgets before lowering the overall budget to ${usd(newHardLimit)}.`,
                    { allocated, requested: newHardLimit });
            }
        } else {
            const overCommit = await overCommitsProject(sql, {
                projectId: before.project_id, userId: before.user_id, type: before.type, window: before.window,
                quotaId: id, nextLimit: newHardLimit,
            });
            if (overCommit) return overCommitError(overCommit);
        }

        const quota = await changeQuotaCapSafely(sql, {
            id,
            newHardLimit,
            expectedHardLimit,
            newPolicy,
            newSoftOveragePct,
            before,
            actor: user,
            reason: reason || null,
            ip: clientIp(request),
        });
        if (!quota) {
            const [current] = await sql`SELECT * FROM quotas WHERE id = ${id} AND deleted_at IS NULL`;
            if (!current) return apiError('NOT_FOUND', 'Budget not found.');
            const { usedByQuota, reservedByQuota } = await usageForQuotas(sql, [current]);
            const used = Number(usedByQuota[id] ?? 0);
            const reserved = Number(reservedByQuota[id] ?? 0);
            const minimumHardLimit = used + reserved;
            if (Number(current.hard_limit) === expectedHardLimit && newHardLimit < minimumHardLimit) {
                return apiError('BUDGET_CAP_TOO_LOW', 'The cap cannot be lower than spent plus in-flight usage.', {
                    currentHardLimit: Number(current.hard_limit), used, reserved, minimumHardLimit,
                });
            }
            return apiError('BUDGET_CONFLICT', 'This budget changed while you were saving. Refresh and try again.', {
                currentHardLimit: Number(current.hard_limit),
                used,
                reserved,
                minimumHardLimit,
            });
        }
        const used = Number(quota.used || 0);
        const reserved = Number(quota.reserved || 0);
        return NextResponse.json({ ...quota, used, reserved });
    }

    const addAmount = Number(body?.addAmount);
    if (!(addAmount > 0) || !Number.isFinite(addAmount)) {
        return apiError('BAD_REQUEST', 'addAmount > 0 is required.');
    }
    if (['image_count', 'request_count'].includes(before.type) && !Number.isInteger(addAmount)) {
        return apiError('BAD_REQUEST', `${before.type} budgets require a whole-number amount.`);
    }
    // A top-up is a delta, so nothing is excluded from the allotted total.
    const topUpOverCommit = await overCommitsProject(sql, {
        projectId: before.project_id, userId: before.user_id, type: before.type, window: before.window,
        nextLimit: addAmount,
    });
    if (topUpOverCommit) return overCommitError(topUpOverCommit);
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
