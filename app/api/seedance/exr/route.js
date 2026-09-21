import { NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { getDb } from '../../../../lib/db/neon.js';
import {
    buildEnhancementRequest,
    createQueueTaskToken,
    readQueueTaskToken,
    validateSourceUrl,
} from '../../../../lib/byteplus/vodEnhance.mjs';
import {
    enqueueExrJob,
    getExrJobForUser,
    publicExrStatus,
} from '../../../../lib/byteplus/exrQueue.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60;

function errorResponse(error) {
    const status = error.status === 400 || error.status === 503 ? error.status : 502;
    return NextResponse.json({ error: error.message || 'EXR queue request failed.' }, { status });
}

async function projectForUser(sql, user, requested) {
    const projectId = Number(requested);
    if (Number.isInteger(projectId) && projectId > 0) {
        if (user.role === 'admin') {
            const [project] = await sql`SELECT id FROM projects WHERE id = ${projectId} AND archived_at IS NULL`;
            return project ? project.id : null;
        }
        const [membership] = await sql`SELECT project_id FROM project_memberships
            WHERE project_id = ${projectId} AND user_id = ${user.userId}`;
        return membership?.project_id || null;
    }
    const [membership] = await sql`SELECT project_id FROM project_memberships
        WHERE user_id = ${user.userId} ORDER BY project_id LIMIT 1`;
    return membership?.project_id || null;
}

export async function POST(request) {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await request.json().catch(() => null);
    if (!body?.sourceUrl) return NextResponse.json({ error: 'sourceUrl is required.' }, { status: 400 });
    if (!validateSourceUrl(body.sourceUrl)) {
        return NextResponse.json({ error: 'The source video must be a public BytePlus HTTPS media URL.' }, { status: 400 });
    }
    try {
        const sql = await getDb();
        if (!sql) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503 });
        const projectId = await projectForUser(sql, user, body.projectId);
        if (!projectId) return NextResponse.json({ error: 'A valid workspace project is required.' }, { status: 400 });
        const requestBody = buildEnhancementRequest({ options: body.options || {} });
        delete requestBody.video_url;
        const job = await enqueueExrJob(sql, {
            userId: user.userId,
            projectId,
            sourceUrl: body.sourceUrl,
            requestBody,
        });
        return NextResponse.json({
            status: 'queued',
            queueId: job.id,
            taskToken: createQueueTaskToken({ queueId: job.id, userId: user.userId }),
        }, { status: 202 });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function GET(request) {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const token = readQueueTaskToken(new URL(request.url).searchParams.get('task'), user.userId);
    if (!token) return NextResponse.json({ error: 'Invalid EXR task.' }, { status: 400 });
    try {
        const sql = await getDb();
        if (!sql) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503 });
        const job = await getExrJobForUser(sql, token.queueId, user.userId);
        if (!job) return NextResponse.json({ error: 'EXR task was not found.' }, { status: 404 });
        const status = publicExrStatus(job);
        const result = status.result || {};
        return NextResponse.json({
            status: status.status,
            queueId: status.id,
            attempt: status.attempt,
            providerTaskId: status.providerTaskId,
            providerRequestId: status.providerRequestId,
            url: result.url || null,
            archiveKey: result.archiveKey || null,
            durable: result.durable ?? false,
            bytes: result.bytes || null,
            metadata: result.metadata || null,
            expiresAt: result.expiresAt || null,
            error: status.error,
        });
    } catch (error) {
        return errorResponse(error);
    }
}
