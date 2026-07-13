import { NextResponse } from 'next/server';
import { gatewayContext, clientIp } from '../../../../../lib/gateway/authz.js';
import { apiError } from '../../../../../lib/gateway/httpError.mjs';
import { writeAudit } from '../../../../../lib/gateway/db.js';

export const runtime = 'nodejs';

const ROLES = ['admin', 'manager', 'member', 'viewer'];

// Add a member or change their role.
export async function POST(request, { params }) {
    const { id } = await params;
    const auth = await gatewayContext({ projectId: Number(id), permission: 'member.manage' });
    if (!auth.ok) return auth.response;
    const { sql, user, project, role } = auth.ctx;
    const body = await request.json().catch(() => null);
    if (!body?.userId || (body.role && !ROLES.includes(body.role))) {
        return apiError('BAD_REQUEST', `userId required; role must be one of ${ROLES.join(', ')}.`);
    }
    // Managers manage members but can't mint admins — only a project/platform
    // admin may grant the 'admin' role (prevents privilege escalation).
    if (body.role === 'admin' && role !== 'admin') {
        return apiError('FORBIDDEN', 'Only an admin can grant the admin role.');
    }
    const [before] = await sql`SELECT role FROM project_memberships WHERE project_id = ${project.id} AND user_id = ${body.userId}`;
    const [row] = await sql`INSERT INTO project_memberships (project_id, user_id, role, added_by)
        VALUES (${project.id}, ${body.userId}, ${body.role || 'member'}, ${user.userId})
        ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
        RETURNING *`;
    await writeAudit(sql, {
        actorId: user.userId, actorEmail: user.email,
        action: before ? 'member.role_change' : 'member.add',
        targetType: 'project_membership', targetId: `${project.id}:${body.userId}`,
        before: before || null, after: { role: row.role }, ip: clientIp(request),
    });
    return NextResponse.json(row, { status: before ? 200 : 201 });
}

export async function DELETE(request, { params }) {
    const { id } = await params;
    const auth = await gatewayContext({ projectId: Number(id), permission: 'member.manage' });
    if (!auth.ok) return auth.response;
    const { sql, user, project } = auth.ctx;
    const userId = new URL(request.url).searchParams.get('userId');
    if (!userId) return apiError('BAD_REQUEST', 'userId query param required.');
    await sql`DELETE FROM project_memberships WHERE project_id = ${project.id} AND user_id = ${userId}`;
    await writeAudit(sql, {
        actorId: user.userId, actorEmail: user.email, action: 'member.remove',
        targetType: 'project_membership', targetId: `${project.id}:${userId}`, ip: clientIp(request),
    });
    return NextResponse.json({ ok: true });
}
