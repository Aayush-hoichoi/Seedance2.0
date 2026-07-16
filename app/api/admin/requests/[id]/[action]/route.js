import { NextResponse } from 'next/server';
import { getUser } from '../../../../../../lib/auth/user.js';
import { setRequestStatus } from '../../../../../../lib/access/db.js';
import { nextStatus } from '../../../../../../lib/access/requestStatus.mjs';
import { getDb } from '../../../../../../lib/db/neon.js';
import { emitEvent, writeAudit } from '../../../../../../lib/gateway/db.js';
import { notifySlackAccessDecided } from '../../../../../../lib/notify/slack.mjs';

export const runtime = 'nodejs';

// Mirror the legacy request decision into the gateway's user_model_overrides —
// the governed pipeline keys access off overrides, so without this an APPROVE
// changed a status row but granted nothing. Same rows scripts/migrate-gateway.mjs
// and the project overrides API write. Best-effort: a pre-migration DB (no
// gateway tables) just keeps the legacy behavior.
async function syncGatewayOverride({ action, row, admin, validUntil }) {
    const sql = await getDb();
    if (!sql) return;
    // Requests store either the model alias (image models: nano-banana-*) or the
    // provider version tag (video models); the gateway keys access by alias, so
    // resolve both forms to the alias.
    const [version] = await sql`SELECT m.id AS model_id FROM models m
        LEFT JOIN model_versions v ON v.model_id = m.id
        WHERE m.id = ${row.model_id} OR v.version_tag = ${row.model_id} LIMIT 1`;
    if (!version) return; // catalog not migrated yet / unknown model
    // Grant on the project the user requested from. Legacy requests (pre
    // per-project) carry no project_id — fall back to the requester's Default.
    let project = row.project_id ? { id: row.project_id } : null;
    if (!project) {
        [project] = await sql`SELECT p.id FROM projects p
            JOIN project_memberships m ON m.project_id = p.id AND m.user_id = ${row.user_id}
            WHERE p.archived_at IS NULL
            ORDER BY (p.name = 'Default') DESC, p.id ASC LIMIT 1`;
    }
    if (!project) return; // requester not enrolled in any project yet

    if (action === 'approve') {
        const [override] = await sql`INSERT INTO user_model_overrides
            (project_id, user_id, model_id, effect, valid_until, created_by, revoked_at)
            VALUES (${project.id}, ${row.user_id}, ${version.model_id}, 'allow', ${validUntil ?? null}, ${admin.userId}, NULL)
            ON CONFLICT (project_id, user_id, model_id)
            DO UPDATE SET effect = 'allow', revoked_at = NULL, valid_until = EXCLUDED.valid_until, created_by = EXCLUDED.created_by
            RETURNING id`;
        await emitEvent(sql, {
            projectId: project.id, userId: row.user_id,
            type: 'access.granted', payload: { modelId: version.model_id, scope: 'user', effect: 'allow', validUntil: validUntil ?? null, via: 'access_request' },
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
        projectId: project.id, userId: row.user_id,
        type: 'access.revoked', payload: { modelId: version.model_id, scope: 'user', removedEffect: 'allow', via: 'access_request' },
    });
    await writeAudit(sql, {
        actorId: admin.userId, actorEmail: admin.email, action: 'override.remove',
        targetType: 'user_model_override', targetId: override.id,
        before: { projectId: project.id, userId: row.user_id, modelId: version.model_id, effect: 'allow', requestId: row.id },
    });
}

export async function POST(request, { params }) {
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
    // Approving requires a future expiry — the grant is time-boxed.
    let validUntil = null;
    if (action === 'approve') {
        const body = await request.json().catch(() => null);
        validUntil = body?.validUntil ?? null;
        const at = validUntil ? Date.parse(validUntil) : NaN;
        if (!validUntil || Number.isNaN(at) || at <= Date.now()) {
            return NextResponse.json({ error: 'A future expiry time (validUntil) is required to approve.' }, { status: 400 });
        }
    }
    const row = await setRequestStatus(requestId, nextStatus(action), admin.email, validUntil);
    if (!row) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    try {
        await syncGatewayOverride({ action, row, admin, validUntil });
    } catch (err) {
        console.error('[access] gateway override sync failed:', err.message); // legacy status is already saved
    }
    // Post the outcome (approved / declined) to Slack. Best-effort.
    await notifySlackAccessDecided({ email: row.user_email, modelId: row.model_id, status: row.status, expiresAt: row.expires_at }).catch(() => {});
    return NextResponse.json({ ok: true, request: row });
}
