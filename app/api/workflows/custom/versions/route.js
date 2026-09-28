import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../../lib/gateway/authz.js';
import { writeAudit } from '../../../../../lib/gateway/db.js';
import { styleError } from '../../../../../lib/gateway/projectStyle.mjs';
import { upgradeWorkflowStyle } from '../../../../../lib/gateway/workflowRefresh.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60; // upgrade is one enhancer-model call

const VERSION_ACTIONS = ['workflow.created', 'workflow.updated', 'workflow.style_refreshed', 'workflow.upgraded', 'workflow.restored'];

// Creator or platform admin only — versioning is a maintainer's view even on
// a public workflow.
async function authorize(sql, user, isPlatformAdmin, workflowId) {
    const [w] = await sql`SELECT id, name, created_by, style FROM workflows
        WHERE id = ${workflowId} AND deleted_at IS NULL`;
    if (!w) return { error: NextResponse.json({ error: 'Workflow not found.' }, { status: 404 }) };
    if (!isPlatformAdmin && w.created_by !== user.userId) {
        return { error: NextResponse.json({ error: 'Only the creator or an admin can see versions.' }, { status: 403 }) };
    }
    return { workflow: w };
}

// Version history, straight from the audit log — every create/edit/nightly
// learn/upgrade/restore has stored a full before/after snapshot since day one.
export async function GET(request) {
    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { sql, user, isPlatformAdmin } = auth.ctx;
    const workflowId = Number(new URL(request.url).searchParams.get('workflowId'));
    if (!workflowId) return NextResponse.json({ error: 'workflowId is required.' }, { status: 400 });
    const gate = await authorize(sql, user, isPlatformAdmin, workflowId);
    if (gate.error) return gate.error;

    const rows = await sql`
        SELECT a.id, a.action, a.actor_id, a.actor_email, a.reason, a.created_at,
               (a.after->>'version')::int AS version
        FROM audit_log a
        WHERE a.target_type = 'workflow' AND a.target_id = ${String(workflowId)}
          AND a.action = ANY(${VERSION_ACTIONS})
        ORDER BY a.created_at DESC
        LIMIT 50`;
    return NextResponse.json({
        currentVersion: gate.workflow.style?.version ?? null,
        versions: rows,
    });
}

// { workflowId, action: 'upgrade' }               → analyze all generations
//   (liked prioritized) and write the generalized result as a new version.
// { workflowId, action: 'restore', auditId }      → bring an old version's
//   content back AS A NEW version — history is never rewritten.
export async function POST(request) {
    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { sql, user, isPlatformAdmin } = auth.ctx;
    const body = await request.json().catch(() => null);
    const workflowId = Number(body?.workflowId);
    if (!workflowId) return NextResponse.json({ error: 'workflowId is required.' }, { status: 400 });
    const gate = await authorize(sql, user, isPlatformAdmin, workflowId);
    if (gate.error) return gate.error;

    if (body?.action === 'upgrade') {
        const result = await upgradeWorkflowStyle(sql, workflowId, { actor: user });
        if (result.error) return NextResponse.json({ error: result.error }, { status: 422 });
        return NextResponse.json(result);
    }

    if (body?.action === 'restore') {
        const auditId = Number(body?.auditId);
        if (!auditId) return NextResponse.json({ error: 'auditId is required.' }, { status: 400 });
        const [snap] = await sql`SELECT after FROM audit_log
            WHERE id = ${auditId} AND target_type = 'workflow' AND target_id = ${String(workflowId)}
              AND action = ANY(${VERSION_ACTIONS})`;
        if (!snap?.after) return NextResponse.json({ error: 'That version snapshot was not found.' }, { status: 404 });
        const current = gate.workflow.style;
        const restored = {
            ...snap.after,
            enabled: current.enabled !== false,
            version: (current.version ?? 0) + 1, // forward, never rewritten
            refreshedAt: null,
        };
        const invalid = styleError(restored);
        if (invalid) return NextResponse.json({ error: `That snapshot no longer validates (${invalid}).` }, { status: 422 });
        await sql`UPDATE workflows SET style = ${JSON.stringify(restored)}::jsonb WHERE id = ${workflowId}`;
        await writeAudit(sql, {
            actorId: user.userId, actorEmail: user.email ?? null, action: 'workflow.restored',
            targetType: 'workflow', targetId: workflowId, before: current, after: restored,
            reason: `restored the v${snap.after.version ?? '?'} snapshot`,
        });
        return NextResponse.json({ version: restored.version });
    }

    return NextResponse.json({ error: 'action must be upgrade or restore.' }, { status: 400 });
}
