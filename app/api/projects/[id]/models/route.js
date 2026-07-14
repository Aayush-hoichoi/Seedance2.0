import { NextResponse } from 'next/server';
import { after } from 'next/server';
import { gatewayContext, clientIp } from '../../../../../lib/gateway/authz.js';
import { apiError } from '../../../../../lib/gateway/httpError.mjs';
import { writeAudit, emitEvent } from '../../../../../lib/gateway/db.js';
import { cancelDeauthorizedQueued } from '../../../../../lib/gateway/sweep.mjs';

export const runtime = 'nodejs';

// Grant a model to the project (all members), optionally time-boxed.
export async function POST(request, { params }) {
    const { id } = await params;
    const auth = await gatewayContext({ projectId: Number(id), permission: 'model.grant' });
    if (!auth.ok) return auth.response;
    const { sql, user, project } = auth.ctx;
    const body = await request.json().catch(() => null);
    if (!body?.modelId) return apiError('BAD_REQUEST', 'modelId is required.');

    const [grant] = await sql`INSERT INTO project_model_grants
        (project_id, model_id, valid_from, valid_until, created_by, revoked_at)
        VALUES (${project.id}, ${body.modelId}, ${body.validFrom ?? null}, ${body.validUntil ?? null}, ${user.userId}, NULL)
        ON CONFLICT (project_id, model_id)
        DO UPDATE SET revoked_at = NULL, valid_from = EXCLUDED.valid_from, valid_until = EXCLUDED.valid_until, created_by = EXCLUDED.created_by
        RETURNING *`;
    await emitEvent(sql, { projectId: project.id, type: 'access.granted', payload: { modelId: body.modelId, scope: 'project', validUntil: body.validUntil ?? null } });
    await writeAudit(sql, {
        actorId: user.userId, actorEmail: user.email, action: 'model.grant',
        targetType: 'project_model_grant', targetId: grant.id,
        after: { projectId: project.id, modelId: body.modelId, validUntil: body.validUntil ?? null },
        reason: body.reason ?? null, ip: clientIp(request),
    });
    return NextResponse.json(grant, { status: 201 });
}

// Revoke: new requests rejected instantly, queued jobs cancelled, running complete (§10.2).
export async function DELETE(request, { params }) {
    const { id } = await params;
    const auth = await gatewayContext({ projectId: Number(id), permission: 'model.grant' });
    if (!auth.ok) return auth.response;
    const { sql, user, project } = auth.ctx;
    const modelId = new URL(request.url).searchParams.get('modelId');
    if (!modelId) return apiError('BAD_REQUEST', 'modelId query param required.');

    const [grant] = await sql`UPDATE project_model_grants SET revoked_at = now()
        WHERE project_id = ${project.id} AND model_id = ${modelId} AND revoked_at IS NULL
        RETURNING *`;
    if (!grant) return apiError('NOT_FOUND', 'No active grant for that model.');
    await emitEvent(sql, { projectId: project.id, type: 'access.revoked', payload: { modelId, scope: 'project' } });
    await writeAudit(sql, {
        actorId: user.userId, actorEmail: user.email, action: 'model.revoke',
        targetType: 'project_model_grant', targetId: grant.id,
        before: { projectId: project.id, modelId }, reason: new URL(request.url).searchParams.get('reason'), ip: clientIp(request),
    });
    after(() => cancelDeauthorizedQueued(sql, { projectId: project.id, modelId }).catch(() => {}));
    return NextResponse.json({ ok: true });
}
