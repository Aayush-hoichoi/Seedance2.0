import { after, NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { getDb } from '../../../../lib/db/neon.js';
import {
    buildEnhancementRequest,
    createQueueTaskToken,
    readQueueTaskToken,
    validateSourceUrl,
} from '../../../../lib/byteplus/vodEnhance.mjs';
import { estimateExrCost, normalizeExrOptions, pricePerExrMinute } from '../../../../lib/byteplus/exrPricing.mjs';
import {
    enqueueExrJob,
    getExrJobForUser,
    publicExrStatus,
} from '../../../../lib/byteplus/exrQueue.mjs';
import { exrProjectForUser, getExrAccess } from '../../../../lib/byteplus/exrAccess.mjs';
import { presignKey } from '../../../../lib/seedance/galleryItem.mjs';
import { drainExrQueue, runExrQueue } from '../../../../scripts/exr-queue-worker.mjs';

export const runtime = 'nodejs';
export const maxDuration = 300;

// One pass per status poll: enough to advance a watched job, and a terminal
// provider state is picked up in a single pass when someone looks again.
function kickExrWorker() {
    after(() => runExrQueue({ once: true }).catch((error) => {
        console.error('[exr-worker] automatic queue pass failed:', error.message);
    }));
}

// After a submit, keep working the queue so the job finishes even if the
// user closes the page. Budget stays under maxDuration; the daily cron
// catches anything that outlives it.
function drainExrWorker() {
    after(() => drainExrQueue({ maxMs: 240_000 }).catch((error) => {
        console.error('[exr-worker] automatic queue drain failed:', error.message);
    }));
}

function errorResponse(error) {
    const status = error.status === 400 || error.status === 503 ? error.status : 502;
    return NextResponse.json({ error: error.message || 'EXR queue request failed.' }, { status });
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
        const projectId = await exrProjectForUser(sql, user, body.projectId);
        if (!projectId) return NextResponse.json({ error: 'A valid workspace project is required.' }, { status: 400 });
        if (user.role !== 'admin') {
            const access = await getExrAccess(sql, { userId: user.userId, projectId });
            if (!access.granted) {
                return NextResponse.json({
                    error: access.status === 'pending'
                        ? 'EXR access is waiting for admin approval.'
                        : 'EXR is locked for this workspace. Request EXR access first.',
                    code: 'EXR_ACCESS_REQUIRED',
                    access,
                }, { status: 403 });
            }
        }
        const options = normalizeExrOptions(body.options || {}, { strict: true });
        const requestBody = buildEnhancementRequest({ options });
        delete requestBody.video_url;
        if (typeof body.sourceTaskId === 'string' && body.sourceTaskId.length <= 200) {
            requestBody._gallery = { sourceTaskId: body.sourceTaskId };
        }
        const durationSeconds = Number(body.durationSeconds);
        requestBody._billing = {
            sourceTaskId: typeof body.sourceTaskId === 'string' && body.sourceTaskId.length <= 200 ? body.sourceTaskId : null,
            durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
            unitPriceUsd: pricePerExrMinute(options),
            estimatedCostUsd: estimateExrCost(options, durationSeconds),
            tier: options.tier,
            resolution: options.resolution,
            fps: options.fps,
            bitDepth: options.bitDepth,
            outputFormat: options.outputFormat,
        };
        const job = await enqueueExrJob(sql, {
            userId: user.userId,
            projectId,
            sourceUrl: body.sourceUrl,
            requestBody,
        });
        drainExrWorker();
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
        if (job.status === 'queued' || job.status === 'processing') kickExrWorker();
        if (user.role !== 'admin') {
            const access = await getExrAccess(sql, { userId: user.userId, projectId: job.project_id });
            if (!access.granted) {
                return NextResponse.json({ error: 'EXR access is not enabled for this workspace.', code: 'EXR_ACCESS_REQUIRED' }, { status: 403 });
            }
        }
        const status = publicExrStatus(job);
        const result = status.result || {};
        const durableUrl = result.archiveKey ? presignKey(result.archiveKey) : null;
        return NextResponse.json({
            status: status.status,
            queueId: status.id,
            attempt: status.attempt,
            providerTaskId: status.providerTaskId,
            providerRequestId: status.providerRequestId,
            url: durableUrl || result.url || null,
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
