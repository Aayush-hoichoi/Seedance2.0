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
import { budgetFor, reserveToolSpend } from '../../../../lib/tools/billing.mjs';
import { drainExrQueue, runExrQueue } from '../../../../scripts/exr-queue-worker.mjs';

// Budget scope for EXR spend in billing_events / quotas. Like Upscale, a
// tool:exr-scoped budget is REQUIRED — nobody runs EXR unlimited; admins
// create one per user or project in Console → Budgets (model "EXR Output").
const EXR_TOOL_ID = 'tool:exr';
const MAX_EXR_DURATION_SECONDS = 6 * 3600; // mirrors the Upscale input ceiling
const MAX_ACTIVE_EXR_PER_USER = 3;

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
        // Like Upscale: a tool:exr-scoped budget must exist (everyone, admins
        // included) — access says who MAY run EXR, the budget says how much.
        const budget = await budgetFor(sql, { projectId, userId: user.userId, toolId: EXR_TOOL_ID });
        if (!budget) {
            return NextResponse.json({
                error: 'No EXR budget is set for you in this project. Ask an admin to create one (model "EXR Output") in Console → Budgets.',
                code: 'NO_BUDGET',
            }, { status: 402 });
        }
        // The duration backs the budget reservation, so it is required and
        // capped — settlement later corrects it to the provider-reported value.
        const durationSeconds = Number(body.durationSeconds);
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
            return NextResponse.json({ error: 'durationSeconds (the clip length) is required.' }, { status: 400 });
        }
        if (durationSeconds > MAX_EXR_DURATION_SECONDS) {
            return NextResponse.json({ error: 'The source video is longer than the 6 hour EXR limit.' }, { status: 400 });
        }
        // One EXR run per source at a time, and a small per-user concurrency
        // cap — each job is real provider spend, so accidental repeats and
        // queue floods are refused up front.
        const [inFlight] = await sql`SELECT count(*)::int AS active,
                count(*) FILTER (WHERE source_url = ${body.sourceUrl})::int AS same_source
            FROM exr_jobs WHERE user_id = ${user.userId} AND status IN ('reserving', 'queued', 'processing')`;
        if (inFlight.same_source > 0) {
            return NextResponse.json({ error: 'An EXR job for this video is already running.' }, { status: 409 });
        }
        if (inFlight.active >= MAX_ACTIVE_EXR_PER_USER) {
            return NextResponse.json({ error: `You already have ${MAX_ACTIVE_EXR_PER_USER} EXR jobs running — wait for one to finish.` }, { status: 429 });
        }
        const options = normalizeExrOptions(body.options || {}, { strict: true });
        const requestBody = buildEnhancementRequest({ options });
        delete requestBody.video_url;
        if (typeof body.sourceTaskId === 'string' && body.sourceTaskId.length <= 200) {
            requestBody._gallery = { sourceTaskId: body.sourceTaskId };
        }
        requestBody._billing = {
            toolId: EXR_TOOL_ID,
            sourceTaskId: typeof body.sourceTaskId === 'string' && body.sourceTaskId.length <= 200 ? body.sourceTaskId : null,
            durationSeconds,
            unitPriceUsd: pricePerExrMinute(options),
            estimatedCostUsd: estimateExrCost(options, durationSeconds),
            tier: options.tier,
            resolution: options.resolution,
            fps: options.fps,
            bitDepth: options.bitDepth,
            outputFormat: options.outputFormat,
        };
        // 'reserving' keeps the job out of the worker's reach until the budget
        // reservation lands; the estimate (client-reported duration) is held
        // against every applicable budget, and the worker settles on the
        // provider-reported duration when the job finishes.
        const job = await enqueueExrJob(sql, {
            userId: user.userId,
            projectId,
            sourceUrl: body.sourceUrl,
            requestBody,
            status: 'reserving',
        });
        const reservation = await reserveToolSpend(sql, {
            exrJobId: job.id, projectId, userId: user.userId, toolId: EXR_TOOL_ID,
            seconds: requestBody._billing.durationSeconds, estCostUsd: requestBody._billing.estimatedCostUsd,
        });
        if (!reservation) {
            await sql`UPDATE exr_jobs SET status = 'rejected', finished_at = now(),
                error = ${JSON.stringify({ code: 'QUOTA_EXCEEDED', message: 'A budget limit would be exceeded.' })}
                WHERE id = ${job.id}`;
            return NextResponse.json({ error: 'A budget limit would be exceeded by this EXR job.', code: 'QUOTA_EXCEEDED' }, { status: 402 });
        }
        await sql`UPDATE exr_jobs SET status = 'queued', updated_at = now() WHERE id = ${job.id} AND status = 'reserving'`;
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
