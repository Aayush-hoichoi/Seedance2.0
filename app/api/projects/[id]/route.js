import { NextResponse } from 'next/server';
import { gatewayContext, clientIp } from '../../../../lib/gateway/authz.js';
import { apiError } from '../../../../lib/gateway/httpError.mjs';
import { writeAudit, emitEvent } from '../../../../lib/gateway/db.js';

export const runtime = 'nodejs';

// Project detail: members, grants, overrides (for the console detail page).
export async function GET(request, { params }) {
    const { id } = await params;
    const auth = await gatewayContext({ projectId: Number(id) });
    if (!auth.ok) return auth.response;
    const { sql, project, role } = auth.ctx;
    // Role shown is the member's PLATFORM role (users.role), not the vestigial
    // per-project membership.role — a user is a manager/admin everywhere or a
    // plain member, set on the Users console.
    const members = await sql`SELECT m.project_id, m.user_id, m.created_at, u.email, u.name,
            COALESCE(u.role, 'member') AS platform_role
        FROM project_memberships m
        LEFT JOIN users u ON u.id = m.user_id WHERE m.project_id = ${project.id} ORDER BY m.created_at`;
    // Only grants actually in effect — an expired grant (valid_until in the
    // past) no longer grants access, so it must not show as an active grant.
    const grants = await sql`SELECT * FROM project_model_grants
        WHERE project_id = ${project.id} AND revoked_at IS NULL
          AND (valid_until IS NULL OR valid_until > now())`;
    const overrides = await sql`SELECT o.*, u.email FROM user_model_overrides o
        LEFT JOIN users u ON u.id = o.user_id
        WHERE o.project_id = ${project.id} AND o.revoked_at IS NULL
          AND (o.valid_until IS NULL OR o.valid_until > now())
        ORDER BY o.created_at DESC`;
    // `role` is the caller's effective role on this project — the client uses it
    // to hide the 'admin' option unless the caller can actually grant it.
    return NextResponse.json({ project, role, members, grants, overrides });
}

// Rename / pause / resume.
export async function PATCH(request, { params }) {
    const { id } = await params;
    const auth = await gatewayContext({ projectId: Number(id), permission: 'project.manage' });
    if (!auth.ok) return auth.response;
    const { sql, user, project } = auth.ctx;
    const body = await request.json().catch(() => ({}));

    if (typeof body.paused === 'boolean' && body.paused !== project.paused) {
        await sql`UPDATE projects SET paused = ${body.paused} WHERE id = ${project.id}`;
        await emitEvent(sql, {
            projectId: project.id,
            type: body.paused ? 'project.paused' : 'project.resumed', payload: { projectId: project.id },
        });
        await writeAudit(sql, {
            actorId: user.userId, actorEmail: user.email, action: body.paused ? 'project.pause' : 'project.resume',
            targetType: 'project', targetId: project.id, reason: body.reason ?? null, ip: clientIp(request),
        });
    }
    if (body.name?.trim() && body.name.trim() !== project.name) {
        await sql`UPDATE projects SET name = ${body.name.trim()} WHERE id = ${project.id}`;
        await writeAudit(sql, {
            actorId: user.userId, actorEmail: user.email, action: 'project.rename',
            targetType: 'project', targetId: project.id, before: { name: project.name }, after: { name: body.name.trim() }, ip: clientIp(request),
        });
    }
    const [fresh] = await sql`SELECT * FROM projects WHERE id = ${project.id}`;
    return NextResponse.json(fresh);
}

// Archive (soft-delete) a project. Admins and org managers may archive — the
// same access that lets them create one (POST /api/projects) — so managers can
// clean up projects they create. Never hard-deletes: jobs/billing keep their
// project_id, and the row just drops out of every archived_at IS NULL query.
export async function DELETE(request, { params }) {
    const { id } = await params;
    const auth = await gatewayContext({ projectId: Number(id) });
    if (!auth.ok) return auth.response;
    const { sql, user, project, isPlatformAdmin, isOrgManager } = auth.ctx;
    if (!isPlatformAdmin && !isOrgManager) {
        return apiError('FORBIDDEN', 'Only admins or managers can archive projects.');
    }
    if (project.name === 'Default') return apiError('BAD_REQUEST', 'The Default project cannot be archived.');
    await sql`UPDATE projects SET archived_at = now() WHERE id = ${project.id}`;
    await writeAudit(sql, {
        actorId: user.userId, actorEmail: user.email, action: 'project.archive',
        targetType: 'project', targetId: project.id, ip: clientIp(request),
    });
    return NextResponse.json({ ok: true });
}
