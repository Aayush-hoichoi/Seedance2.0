import { NextResponse } from 'next/server';
import { getUser, isAdmin } from '../../../../lib/auth/user.js';
import { getDb } from '../../../../lib/db/neon.js';
import { cancelExrJob, getExrQueue, retryExrJob } from '../../../../lib/byteplus/exrQueue.mjs';
import { writeAudit } from '../../../../lib/gateway/db.js';

export const runtime = 'nodejs';

const STATUSES = new Set(['queued', 'processing', 'succeeded', 'failed', 'cancelled']);

export async function GET(request) {
    if (!(await isAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const sql = await getDb();
    if (!sql) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503 });
    const url = new URL(request.url);
    const requestedStatus = url.searchParams.get('status');
    const status = STATUSES.has(requestedStatus) ? requestedStatus : null;
    const queue = await getExrQueue(sql, { status, limit: url.searchParams.get('limit') });
    return NextResponse.json(queue);
}

export async function PATCH(request) {
    const admin = await getUser();
    if (admin?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const sql = await getDb();
    if (!sql) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503 });
    const body = await request.json().catch(() => null);
    const id = Number(body?.id);
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'A valid EXR queue id is required.' }, { status: 400 });
    if (!['retry', 'cancel'].includes(body?.action)) return NextResponse.json({ error: 'action must be retry or cancel.' }, { status: 400 });

    const row = body.action === 'retry' ? await retryExrJob(sql, id) : await cancelExrJob(sql, id);
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
