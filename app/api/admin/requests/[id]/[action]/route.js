import { NextResponse } from 'next/server';
import { getUser } from '../../../../../../lib/auth/user.js';
import { setRequestStatus } from '../../../../../../lib/access/db.js';
import { nextStatus } from '../../../../../../lib/access/requestStatus.mjs';
import { getDb } from '../../../../../../lib/db/neon.js';
import { emitEvent, writeAudit } from '../../../../../../lib/gateway/db.js';

export const runtime = 'nodejs';

// Mirror the legacy request decision into the gateway's user_model_overrides —
// the governed pipeline keys access off overrides, so without this an APPROVE
// changed a status row but granted nothing. Same rows scripts/migrate-gateway.mjs
// and the project overrides API write. Best-effort: a pre-migration DB (no
// gateway tables) just keeps the legacy behavior.
async function syncGatewayOverride({ action, row, admin }) {
    const sql = await getDb();
    if (!sql) return;
    // Requests store the provider tag; the gateway keys access by model alias.
    const [version] = await sql`SELECT model_id FROM model_versions WHERE version_tag = ${row.model_id} LIMIT 1`;
    if (!version) return; // catalog not migrated yet
    // The requester's project — prefer the org's Default project.
    const [project] = await sql`SELECT p.id, p.org_id FROM projects p
        JOIN project_memberships m ON m.project_id = p.id AND m.user_id = ${row.user_id}
        WHERE p.archived_at IS NULL
        ORDER BY (p.name = 'Default') DESC, p.id ASC LIMIT 1`;
    if (!project) return; // requester not enrolled in any project yet

    if (action === 'approve') {
        const [override] = await sql`INSERT INTO user_model_overrides
            (project_id, user_id, model_id, effect, created_by, revoked_at)
            VALUES (${project.id}, ${row.user_id}, ${version.model_id}, 'allow', ${admin.userId}, NULL)
            ON CONFLICT (project_id, user_id, model_id)
            DO UPDATE SET effect = 'allow', revoked_at = NULL, created_by = EXCLUDED.created_by
            RETURNING id`;
        await emitEvent(sql, {
            orgId: project.org_id, projectId: project.id, userId: row.user_id,
            type: 'access.granted', payload: { modelId: version.model_id, scope: 'user', effect: 'allow', via: 'access_request' },
        });
        await writeAudit(sql, {
            actorId: admin.userId, actorEmail: admin.email, action: 'override.allow',
            targetType: 'user_model_override', targetId: override.id,
            after: { projectId: project.id, userId: row.user_id, modelId: version.model_id, effect: 'allow', requestId: row.id },
        });
        return;
    }
    // revoke: void any live allow override for this user + model.
    const [override] = await sql`UPDATE user_model_overrides SET revoked_at = now()
        WHERE project_id = ${project.id} AND user_id = ${row.user_id} AND model_id = ${version.model_id}
          AND effect = 'allow' AND revoked_at IS NULL
        RETURNING id`;
    if (!override) return; // nothing granted on the gateway side
    await emitEvent(sql, {
        orgId: project.org_id, projectId: project.id, userId: row.user_id,
        type: 'access.revoked', payload: { modelId: version.model_id, scope: 'user', removedEffect: 'allow', via: 'access_request' },
    });
    await writeAudit(sql, {
        actorId: admin.userId, actorEmail: admin.email, action: 'override.remove',
        targetType: 'user_model_override', targetId: override.id,
        before: { projectId: project.id, userId: row.user_id, modelId: version.model_id, effect: 'allow', requestId: row.id },
    });
}

export async function POST(_request, { params }) {
    const admin = await getUser();
    if (!admin || admin.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const { id, action } = await params;
    if (action !== 'approve' && action !== 'revoke') {
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
    const requestId = Number(id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
        return NextResponse.json({ error: 'Invalid request id' }, { status: 400 });
    }
    const row = await setRequestStatus(requestId, nextStatus(action), admin.email);
    if (!row) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    try {
        await syncGatewayOverride({ action, row, admin });
    } catch (err) {
        console.error('[access] gateway override sync failed:', err.message); // legacy status is already saved
    }
    return NextResponse.json({ ok: true, request: row });
}
