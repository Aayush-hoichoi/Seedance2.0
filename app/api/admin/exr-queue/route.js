import { NextResponse } from 'next/server';
import { getUser, isAdmin } from '../../../../lib/auth/user.js';
import { getDb } from '../../../../lib/db/neon.js';
import { cancelExrJob, getExrQueue, rearchiveExrJob, retryExrJob } from '../../../../lib/byteplus/exrQueue.mjs';
import { decideExrAccessRequest, listExrAccessRequests } from '../../../../lib/byteplus/exrAccess.mjs';
import { emitEvent, writeAudit } from '../../../../lib/gateway/db.js';

export const runtime = 'nodejs';

const STATUSES = new Set(['queued', 'processing', 'succeeded', 'failed', 'cancelled']);

export async function GET(request) {
    if (!(await isAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const sql = await getDb();
    if (!sql) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503 });
    const url = new URL(request.url);
    const requestedStatus = url.searchParams.get('status');
    const status = STATUSES.has(requestedStatus) ? requestedStatus : null;
    const [queue, accessRequests] = await Promise.all([
        getExrQueue(sql, { status, limit: url.searchParams.get('limit') }),
        listExrAccessRequests(sql),
    ]);
    return NextResponse.json({
        ...queue,
        accessRequests,
        accessRequestCount: accessRequests.filter((request) => request.status === 'pending').length,
    });
}

export async function PATCH(request) {
    const admin = await getUser();
    if (admin?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const sql = await getDb();
    if (!sql) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503 });
    const body = await request.json().catch(() => null);
    if (['approve_access', 'deny_access'].includes(body?.action)) {
        const requestId = Number(body?.requestId);
        if (!Number.isInteger(requestId) || requestId <= 0) {
            return NextResponse.json({ error: 'A valid EXR access request id is required.' }, { status: 400 });
        }
        const nextStatus = body.action === 'approve_access' ? 'approved' : 'denied';
        const row = await decideExrAccessRequest(sql, {
            id: requestId,
            status: nextStatus,
            decidedBy: admin.userId,
            expiresAt: null,
        });
        if (!row) return NextResponse.json({ error: 'The EXR access request is no longer pending.' }, { status: 409 });
        await emitEvent(sql, {
            projectId: row.project_id,
            userId: row.user_id,
            type: nextStatus === 'approved' ? 'exr.access.approved' : 'exr.access.denied',
            payload: { requestId: row.id },
        });
        await writeAudit(sql, {
            actorId: admin.userId,
            actorEmail: admin.email,
            action: `exr_access.${nextStatus}`,
            targetType: 'exr_access_request',
            targetId: requestId,
            after: { status: nextStatus, projectId: row.project_id, userId: row.user_id },
        });
        return NextResponse.json({ request: row });
    }
    const id = Number(body?.id);
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'A valid EXR queue id is required.' }, { status: 400 });
    if (!['retry', 'cancel', 'rearchive'].includes(body?.action)) return NextResponse.json({ error: 'action must be retry, cancel, or rearchive.' }, { status: 400 });

    const row = body.action === 'retry'
        ? await retryExrJob(sql, id)
        : body.action === 'rearchive'
            ? await rearchiveExrJob(sql, id)
            : await cancelExrJob(sql, id);
    if (!row) return NextResponse.json({ error: 'The EXR job is not in a state that can be changed.' }, { status: 409 });
    await writeAudit(sql, {
        actorId: admin.userId,
        actorEmail: admin.email,
        action: `exr_queue.${body.action}`,
        targetType: 'exr_job',
        targetId: id,
        after: { status: row.status, id },
    });
    return NextResponse.json(row);
}
