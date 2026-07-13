import { NextResponse } from 'next/server';
import { gatewayContext, clientIp } from '../../../lib/gateway/authz.js';
import { apiError } from '../../../lib/gateway/httpError.mjs';
import { writeAudit } from '../../../lib/gateway/db.js';

export const runtime = 'nodejs';

// My projects (admins see all).
export async function GET() {
    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { sql, user, org, role } = auth.ctx;
    // spent_usd uses the canonical rollup semantics (usageQuery.js): settled
    // cost when known, else the estimate, over settlement + failure events.
    const rows = role === 'admin'
        ? await sql`SELECT p.*,
              (SELECT count(*)::int FROM project_memberships m WHERE m.project_id = p.id) AS member_count,
              (SELECT COALESCE(SUM(COALESCE(b.cost_usd, b.est_cost_usd, 0)), 0)::float8 FROM billing_events b
                WHERE b.project_id = p.id AND b.event_type IN ('settlement', 'failure')) AS spent_usd
           FROM projects p WHERE p.org_id = ${org.id} AND p.archived_at IS NULL ORDER BY p.created_at`
        : await sql`SELECT p.*, m2.role AS my_role,
              (SELECT count(*)::int FROM project_memberships m WHERE m.project_id = p.id) AS member_count,
              (SELECT COALESCE(SUM(COALESCE(b.cost_usd, b.est_cost_usd, 0)), 0)::float8 FROM billing_events b
                WHERE b.project_id = p.id AND b.event_type IN ('settlement', 'failure')) AS spent_usd
           FROM projects p JOIN project_memberships m2 ON m2.project_id = p.id AND m2.user_id = ${user.userId}
           WHERE p.org_id = ${org.id} AND p.archived_at IS NULL ORDER BY p.created_at`;
    return NextResponse.json({ items: rows, role });
}

export async function POST(request) {
    const auth = await gatewayContext({ permission: 'project.manage' });
    if (!auth.ok) return auth.response;
    const { sql, user, org } = auth.ctx;
    const body = await request.json().catch(() => null);
    const name = body?.name?.trim();
    if (!name) return apiError('BAD_REQUEST', 'Project name is required.');
    const [project] = await sql`INSERT INTO projects (org_id, name, created_by)
        VALUES (${org.id}, ${name}, ${user.userId})
        ON CONFLICT (org_id, name) DO UPDATE SET archived_at = NULL
        RETURNING *`;
    await sql`INSERT INTO project_memberships (project_id, user_id, role, added_by)
        VALUES (${project.id}, ${user.userId}, 'admin', ${user.userId})
        ON CONFLICT DO NOTHING`;
    await writeAudit(sql, {
        actorId: user.userId, actorEmail: user.email, action: 'project.create',
        targetType: 'project', targetId: project.id, after: { name }, ip: clientIp(request),
    });
    return NextResponse.json(project, { status: 201 });
}
