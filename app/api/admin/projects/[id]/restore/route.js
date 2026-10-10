import { NextResponse } from 'next/server';
import { gatewayContext, clientIp } from '../../../../../../lib/gateway/authz.js';
import { apiError } from '../../../../../../lib/gateway/httpError.mjs';
import { writeAudit } from '../../../../../../lib/gateway/db.js';

export const runtime = 'nodejs';

// Restore an archived project in place, preserving its original memberships,
// settings, jobs, spend and audit history.
export async function POST(request, { params }) {
    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id < 1) return apiError('BAD_REQUEST', 'Invalid project ID.');

    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { sql, user, isPlatformAdmin } = auth.ctx;
    if (!isPlatformAdmin) return apiError('FORBIDDEN', 'Only admins can restore projects.');

    const [project] = await sql`UPDATE projects SET archived_at = NULL
        WHERE id = ${id} AND archived_at IS NOT NULL RETURNING id, name`;
    if (!project) return apiError('NOT_FOUND', 'Archived project not found.');

    await writeAudit(sql, {
        actorId: user.userId, actorEmail: user.email, action: 'project.restore',
        targetType: 'project', targetId: project.id, after: { name: project.name, archived_at: null }, ip: clientIp(request),
    });
    return NextResponse.json({ ok: true, project });
}
