import { NextResponse } from 'next/server';
import { gatewayContext, clientIp } from '../../../../../lib/gateway/authz.js';
import { apiError } from '../../../../../lib/gateway/httpError.mjs';
import { writeAudit } from '../../../../../lib/gateway/db.js';

export const runtime = 'nodejs';

// Add a member to the project. Roles are platform-level (Users console), NOT
// per-project — this only records that the user belongs to the project. The
// stored membership.role is always 'member' and is ignored by authz.
export async function POST(request, { params }) {
    const { id } = await params;
    const auth = await gatewayContext({ projectId: Number(id), permission: 'member.manage' });
    if (!auth.ok) return auth.response;
    const { sql, user, project } = auth.ctx;
    const body = await request.json().catch(() => null);
    if (!body?.userId) return apiError('BAD_REQUEST', 'userId is required.');

    const [before] = await sql`SELECT 1 FROM project_memberships WHERE project_id = ${project.id} AND user_id = ${body.userId}`;
    const [row] = await sql`INSERT INTO project_memberships (project_id, user_id, role, added_by)
        VALUES (${project.id}, ${body.userId}, 'member', ${user.userId})
        ON CONFLICT (project_id, user_id) DO NOTHING
        RETURNING *`;
    if (!before) {
        await writeAudit(sql, {
            actorId: user.userId, actorEmail: user.email, action: 'member.add',
            targetType: 'project_membership', targetId: `${project.id}:${body.userId}`,
            after: { added: true }, ip: clientIp(request),
        });
    }
    return NextResponse.json(row ?? { ok: true, alreadyMember: true }, { status: before ? 200 : 201 });
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
