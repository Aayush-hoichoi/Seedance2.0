import { NextResponse } from 'next/server';
import { after } from 'next/server';
import { gatewayContext, clientIp } from '../../../../../lib/gateway/authz.js';
import { apiError } from '../../../../../lib/gateway/httpError.mjs';
import { writeAudit, emitEvent } from '../../../../../lib/gateway/db.js';
import { cancelDeauthorizedQueued } from '../../../../../lib/gateway/sweep.mjs';
import { supportedResolutionsFor } from '../../../../../lib/seedance/constants.js';

export const runtime = 'nodejs';

// Per-user ALLOW/DENY override with optional expiry (design §2).
export async function POST(request, { params }) {
    const { id } = await params;
    const auth = await gatewayContext({ projectId: Number(id), permission: 'override.manage' });
    if (!auth.ok) return auth.response;
    const { sql, user, project } = auth.ctx;
    const body = await request.json().catch(() => null);
    if (!body?.userId || !body?.modelId || !['allow', 'deny'].includes(body?.effect)) {
        return apiError('BAD_REQUEST', 'userId, modelId and effect (allow|deny) are required.');
    }
    // A quality cap only means something on an allow — a deny grants nothing to
    // cap. Must be a tier this model actually supports, or the gateway would
    // enforce a ceiling no resolution can satisfy.
    const tiers = supportedResolutionsFor(body.modelId) ?? [];
    const maxResolution = body.effect === 'allow' && body.maxResolution ? String(body.maxResolution) : null;
    if (maxResolution && !tiers.includes(maxResolution)) {
        return apiError('BAD_REQUEST', `maxResolution must be one of: ${tiers.join(', ') || 'none'}.`);
    }
    // The uniqueness on (project_id, user_id, model_id) is a PARTIAL index
    // (… WHERE source_request_id IS NULL), so the arbiter needs that same
    // predicate — a bare column list matches no constraint and Postgres rejects
    // the statement outright, 500ing every save from the project access editor.
    // Same shape as lib/access/gatewaySync.mjs; both write manual-scope rows.
    const [override] = await sql`INSERT INTO user_model_overrides
        (project_id, user_id, model_id, effect, max_resolution, valid_from, valid_until, created_by, revoked_at)
        VALUES (${project.id}, ${body.userId}, ${body.modelId}, ${body.effect}, ${maxResolution}, ${body.validFrom ?? null}, ${body.validUntil ?? null}, ${user.userId}, NULL)
        ON CONFLICT (project_id, user_id, model_id) WHERE source_request_id IS NULL
        DO UPDATE SET effect = EXCLUDED.effect, revoked_at = NULL, max_resolution = EXCLUDED.max_resolution, valid_from = EXCLUDED.valid_from, valid_until = EXCLUDED.valid_until, created_by = EXCLUDED.created_by
        RETURNING *`;
    await emitEvent(sql, {
        projectId: project.id, userId: body.userId,
        type: body.effect === 'deny' ? 'access.revoked' : 'access.granted',
        payload: { modelId: body.modelId, scope: 'user', effect: body.effect, maxResolution, validUntil: body.validUntil ?? null },
    });
    await writeAudit(sql, {
        actorId: user.userId, actorEmail: user.email, action: `override.${body.effect}`,
        targetType: 'user_model_override', targetId: override.id,
        after: { projectId: project.id, userId: body.userId, modelId: body.modelId, effect: body.effect, maxResolution, validUntil: body.validUntil ?? null },
        reason: body.reason ?? null, ip: clientIp(request),
    });
    if (body.effect === 'deny') {
        after(() => cancelDeauthorizedQueued(sql, { projectId: project.id, modelId: body.modelId, userId: body.userId }).catch(() => {}));
    }
    return NextResponse.json(override, { status: 201 });
}

export async function DELETE(request, { params }) {
    const { id } = await params;
    const auth = await gatewayContext({ projectId: Number(id), permission: 'override.manage' });
    if (!auth.ok) return auth.response;
    const { sql, user, project } = auth.ctx;
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    const modelId = url.searchParams.get('modelId');
    if (!userId || !modelId) return apiError('BAD_REQUEST', 'userId and modelId query params required.');

    const [override] = await sql`UPDATE user_model_overrides SET revoked_at = now()
        WHERE project_id = ${project.id} AND user_id = ${userId} AND model_id = ${modelId} AND revoked_at IS NULL
        RETURNING *`;
    if (!override) return apiError('NOT_FOUND', 'No active override.');
    await emitEvent(sql, {
        projectId: project.id, userId,
        type: override.effect === 'allow' ? 'access.revoked' : 'access.granted',
        payload: { modelId, scope: 'user', removedEffect: override.effect },
    });
    await writeAudit(sql, {
        actorId: user.userId, actorEmail: user.email, action: 'override.remove',
        targetType: 'user_model_override', targetId: override.id,
        before: { userId, modelId, effect: override.effect }, ip: clientIp(request),
    });
    if (override.effect === 'allow') {
        after(() => cancelDeauthorizedQueued(sql, { projectId: project.id, modelId, userId }).catch(() => {}));
    }
    return NextResponse.json({ ok: true });
}
