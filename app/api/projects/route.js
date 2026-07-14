import { NextResponse } from 'next/server';
import { gatewayContext, clientIp } from '../../../lib/gateway/authz.js';
import { apiError } from '../../../lib/gateway/httpError.mjs';
import { writeAudit } from '../../../lib/gateway/db.js';

export const runtime = 'nodejs';

// Project list. Platform admins and workspace managers see EVERY project; plain
// members/viewers see only the projects they belong to.
export async function GET() {
    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { sql, user, role, isPlatformAdmin, isOrgManager } = auth.ctx;
    const canManageProjects = isPlatformAdmin || isOrgManager; // create + manage any project
    // spent_usd uses the canonical rollup semantics (usageQuery.js): settled
    // cost when known, else the estimate, over settlement + failure events.
    // A LEFT JOIN carries my_role (null for admins/managers not directly on it).
    const rows = canManageProjects
        ? await sql`SELECT p.*, m2.role AS my_role,
              (SELECT count(*)::int FROM project_memberships m WHERE m.project_id = p.id) AS member_count,
              (SELECT COALESCE(SUM(COALESCE(b.cost_usd, b.est_cost_usd, 0)), 0)::float8 FROM billing_events b
                WHERE b.project_id = p.id AND b.event_type IN ('settlement', 'failure')) AS spent_usd
           FROM projects p LEFT JOIN project_memberships m2 ON m2.project_id = p.id AND m2.user_id = ${user.userId}
           WHERE p.archived_at IS NULL ORDER BY p.created_at`
        : await sql`SELECT p.*, m2.role AS my_role,
              (SELECT count(*)::int FROM project_memberships m WHERE m.project_id = p.id) AS member_count,
              (SELECT COALESCE(SUM(COALESCE(b.cost_usd, b.est_cost_usd, 0)), 0)::float8 FROM billing_events b
                WHERE b.project_id = p.id AND b.event_type IN ('settlement', 'failure')) AS spent_usd
           FROM projects p JOIN project_memberships m2 ON m2.project_id = p.id AND m2.user_id = ${user.userId}
           WHERE p.archived_at IS NULL ORDER BY p.created_at`;
    return NextResponse.json({ items: rows, role, canManageProjects });
}

export async function POST(request) {
    // Platform admins and org managers may create projects (not plain members).
    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { sql, user, isPlatformAdmin, isOrgManager } = auth.ctx;
    if (!isPlatformAdmin && !isOrgManager) {
        return apiError('FORBIDDEN', 'Only admins or managers can create projects.');
    }
    const body = await request.json().catch(() => null);
    const name = body?.name?.trim();
    if (!name) return apiError('BAD_REQUEST', 'Project name is required.');
    const [project] = await sql`INSERT INTO projects (name, created_by)
        VALUES (${name}, ${user.userId})
        ON CONFLICT (name) DO UPDATE SET archived_at = NULL
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
