import { NextResponse, after } from 'next/server';
import { gatewayContext } from '../../../../lib/gateway/authz.js';
import { sweep } from '../../../../lib/gateway/sweep.mjs';
import { apiError } from '../../../../lib/gateway/httpError.mjs';
import { getJob } from '../../../../lib/gateway/db.js';
import { cancelJob } from '../../../../lib/gateway/cancel.mjs';
import { hasPermission } from '../../../../lib/gateway/access.mjs';

export const runtime = 'nodejs';

async function loadFor(request, params) {
    const { id } = await params;
    const auth = await gatewayContext({});
    if (!auth.ok) return { response: auth.response };
    const { sql, user, role } = auth.ctx;
    const job = await getJob(sql, Number(id));
    if (!job) return { response: apiError('NOT_FOUND', 'Generation not found.') };
    if (job.user_id !== user.userId) {
        // Not the creator: needs project membership + usage.view.
        const scoped = await gatewayContext({ projectId: job.project_id, permission: 'usage.view' });
        if (!scoped.ok) return { response: scoped.response };
        return { sql, user, role: scoped.ctx.role, job, own: false };
    }
    return { sql, user, role, job, own: true };
}

export async function GET(request, { params }) {
    const r = await loadFor(request, params);
    if (r.response) return r.response;
    after(() => sweep().catch(() => {})); // status polls drive queue maintenance (no cron on Hobby)
    const { sql, job, own, role } = r;
    let body = job;
    if (!own) {
        const rolePerms = await sql`SELECT role_id, permission_id FROM role_permissions`;
        if (!hasPermission(role, 'prompt.view', rolePerms)) {
            body = { ...job, request_body: { category: job.request_body?.category ?? null } };
        }
    }
    return NextResponse.json(body);
}

export async function DELETE(request, { params }) {
    const r = await loadFor(request, params);
    if (r.response) return r.response;
    const { sql, job, own, role } = r;
    if (!own && role !== 'admin' && role !== 'manager') {
        return apiError('FORBIDDEN', 'Only the creator or a manager can cancel this generation.');
    }
    const cancelled = await cancelJob(sql, job, { reason: own ? 'cancelled by creator' : 'cancelled by admin' });
    if (!cancelled) return apiError('BAD_REQUEST', 'Generation already finished.');
    return NextResponse.json({ ok: true, status: 'cancelled' });
}
