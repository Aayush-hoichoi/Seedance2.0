import { after, NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { getDb } from '../../../../lib/db/neon.js';
import { createQueueTaskToken, readQueueTaskToken, validateSourceUrl } from '../../../../lib/byteplus/vodEnhance.mjs';
import { buildUpscaleRequest, containerFor, estimateUpscaleCost, estimateUpscaleMinutes, sourceTooLarge, upscaleSummary } from '../../../../lib/byteplus/upscaleOptions.mjs';
import { getExrJobForUser, publicExrStatus } from '../../../../lib/byteplus/exrQueue.mjs';
import { exrProjectForUser } from '../../../../lib/byteplus/exrAccess.mjs';
import { presignKey } from '../../../../lib/seedance/galleryItem.mjs';
import { reserveToolSpend, toolStatus } from '../../../../lib/tools/billing.mjs';
import { drainExrQueue, runExrQueue } from '../../../../scripts/exr-queue-worker.mjs';

// Upscale rides the EXR pipeline (same MediaKit endpoint, exr_jobs queue,
// worker and TOS archive) but has its own access grant and budget:
// model_id 'tool:upscale' in the regular access-request and quota tables.
const TOOL_ID = 'tool:upscale';
// Optional BytePlus MediaKit queue for upscale tasks, so their cost is split
// from EXR in the BytePlus console. Unset = the API key project's default queue.
const PROVIDER_QUEUE_ID = process.env.BYTEPLUS_VOD_UPSCALE_QUEUE_ID?.trim() || null;

export const runtime = 'nodejs';
export const maxDuration = 300;

const json = (body, status = 200) => NextResponse.json(body, { status });

export async function POST(request) {
    const user = await getUser();
    if (!user) return json({ error: 'Unauthorized' }, 401);
    const body = await request.json().catch(() => null);
    if (!body?.sourceUrl || !validateSourceUrl(body.sourceUrl)) {
        return json({ error: 'Upload the source video first — it must be stored on BytePlus.' }, 400);
    }
    const source = { seconds: Number(body.source?.seconds), width: Number(body.source?.width), height: Number(body.source?.height) };
    // The estimate reserves budget up front; the worker settles on the
    // provider-reported output duration, so an understated duration here
    // cannot lower the final charge.
    if (!Number.isFinite(source.seconds) || source.seconds <= 0 || source.seconds > 6 * 3600) {
        return json({ error: 'Could not read the video duration — pick the file again.' }, 400);
    }
    if (sourceTooLarge(source.width, source.height)) {
        return json({ error: 'Source video is above 2K — BytePlus only accepts input up to 2K.' }, 400);
    }
    let built;
    try {
        built = buildUpscaleRequest(body.options, { sourceSeconds: source.seconds });
    } catch (error) {
        return json({ error: error.message }, 400);
    }
    const estimate = estimateUpscaleCost(built.options, source);

    try {
        const sql = await getDb();
        if (!sql) return json({ error: 'Database is not configured.' }, 503);
        const projectId = await exrProjectForUser(sql, user, body.projectId);
        if (!projectId) return json({ error: 'A valid workspace project is required.' }, 400);

        const status = await toolStatus(sql, { projectId, userId: user.userId, toolId: TOOL_ID });
        if (!status.allowed) {
            return json({ error: status.requestStatus === 'pending' ? 'Your Upscale access request is waiting for admin approval.' : 'Request access to Upscale first.', code: 'TOOL_ACCESS_REQUIRED' }, 403);
        }
        if (!status.budget) {
            return json({ error: 'No Upscale budget is set for you in this project. Ask an admin for one.', code: 'NO_BUDGET' }, 402);
        }
        if (status.budget.remainingUsd != null && estimate > status.budget.remainingUsd) {
            return json({ error: `This upscale is estimated at $${estimate.toFixed(2)} but only $${status.budget.remainingUsd.toFixed(2)} of budget is left.`, code: 'QUOTA_EXCEEDED' }, 402);
        }

        const container = containerFor(built.options);
        // 'reserving' is never claimed by the worker (it takes queued|processing),
        // so nothing runs until the reservation below succeeds.
        // ponytail: a crash between reserve and the flip strands a held reservation; add a sweep if it ever happens.
        const [job] = await sql`INSERT INTO exr_jobs (project_id, user_id, source_url, request_body, status, run_after)
            VALUES (${projectId}, ${user.userId}, ${body.sourceUrl}, ${JSON.stringify({
                ...built.body,
                ...(PROVIDER_QUEUE_ID ? { queue_id: PROVIDER_QUEUE_ID } : {}),
                _upscale: { container, options: built.options, source, sourceName: String(body.sourceName || '').slice(0, 200) },
                _billing: { kind: 'upscale', toolId: TOOL_ID, durationSeconds: source.seconds, estimatedCostUsd: estimate, tier: built.options.version, outputFormat: container.toUpperCase() },
            })}, 'reserving', now())
            RETURNING id`;
        const reservation = await reserveToolSpend(sql, {
            exrJobId: job.id, projectId, userId: user.userId, toolId: TOOL_ID, seconds: source.seconds, estCostUsd: estimate,
        });
        if (!reservation) {
            await sql`UPDATE exr_jobs SET status = 'rejected', finished_at = now(),
                error = ${JSON.stringify({ code: 'QUOTA_EXCEEDED', message: 'A budget limit would be exceeded.' })}
                WHERE id = ${job.id}`;
            return json({ error: 'A budget limit would be exceeded by this upscale.', code: 'QUOTA_EXCEEDED' }, 402);
        }
        await sql`UPDATE exr_jobs SET status = 'queued', updated_at = now() WHERE id = ${job.id} AND status = 'reserving'`;

        after(() => drainExrQueue({ maxMs: 240_000 }).catch((error) => {
            console.error('[exr-worker] upscale queue drain failed:', error.message);
        }));
        return json({ status: 'queued', queueId: job.id, estimateUsd: estimate, taskToken: createQueueTaskToken({ queueId: job.id, userId: user.userId }) }, 202);
    } catch (error) {
        console.error('[upscale] submit failed:', error);
        return json({ error: 'Upscale request failed. Try again.' }, error.status === 503 ? 503 : 502);
    }
}

const HISTORY_LIMIT = 100;

// One history row for the rail. Charged cost comes from the settlement event
// (the worker's provider-duration price), falling back to the estimate.
function historyItem(job) {
    const up = job.request_body?._upscale || {};
    const result = job.result || {};
    return {
        id: job.id,
        token: createQueueTaskToken({ queueId: job.id, userId: job.user_id }),
        status: job.status,
        name: up.sourceName || `UPS-${job.id}`,
        summary: upscaleSummary(up.options),
        options: up.options || null,
        source: up.source || null,
        providerTaskId: job.provider_task_id || null,
        container: up.container || 'mp4',
        estimateUsd: job.request_body?._billing?.estimatedCostUsd ?? null,
        costUsd: job.cost_usd == null ? null : Number(job.cost_usd),
        waitMin: estimateUpscaleMinutes(up.options, up.source?.seconds),
        sourceUrl: job.source_url,
        url: (result.archiveKey ? presignKey(result.archiveKey) : null) || result.url || null,
        durable: result.durable ?? false,
        metadata: result.metadata || null,
        error: job.error?.message || null,
        createdAt: job.created_at,
        finishedAt: job.finished_at,
    };
}

// The signed-in user's upscales in one project, newest first.
async function listHistory(sql, user, projectParam) {
    const projectId = await exrProjectForUser(sql, user, projectParam);
    if (!projectId) return json({ error: 'A valid workspace project is required.' }, 400);
    const rows = await sql`SELECT j.*, b.cost_usd
        FROM exr_jobs j
        LEFT JOIN LATERAL (
            SELECT cost_usd FROM billing_events
            WHERE generation_id = -j.id AND event_type = 'settlement' LIMIT 1
        ) b ON true
        WHERE j.user_id = ${user.userId} AND j.project_id = ${projectId}
          AND j.request_body ? '_upscale' AND j.status <> 'reserving'
        ORDER BY j.created_at DESC LIMIT ${HISTORY_LIMIT}`;
    if (rows.some((r) => r.status === 'queued' || r.status === 'processing')) {
        after(() => runExrQueue({ once: true }).catch((error) => console.error('[exr-worker] queue pass failed:', error.message)));
    }
    return json({ items: rows.map(historyItem) });
}

// ?list=1&projectId= → history for the rail. ?task= → one job's status.
// No access re-check: jobs were admitted (and budgeted) at submit time, and
// both reads are scoped to the signed-in user.
export async function GET(request) {
    const user = await getUser();
    if (!user) return json({ error: 'Unauthorized' }, 401);
    const params = new URL(request.url).searchParams;
    if (params.get('list')) {
        try {
            const sql = await getDb();
            if (!sql) return json({ error: 'Database is not configured.' }, 503);
            return await listHistory(sql, user, params.get('projectId'));
        } catch (error) {
            console.error('[upscale] history failed:', error);
            return json({ error: 'Could not load upscale history.' }, 502);
        }
    }
    const token = readQueueTaskToken(params.get('task'), user.userId);
    if (!token) return json({ error: 'Invalid upscale task.' }, 400);
    try {
        const sql = await getDb();
        if (!sql) return json({ error: 'Database is not configured.' }, 503);
        const job = await getExrJobForUser(sql, token.queueId, user.userId);
        if (!job?.request_body?._upscale) return json({ error: 'Upscale task was not found.' }, 404);
        if (job.status === 'queued' || job.status === 'processing') {
            after(() => runExrQueue({ once: true }).catch((error) => console.error('[exr-worker] queue pass failed:', error.message)));
        }
        const status = publicExrStatus(job);
        const result = status.result || {};
        return json({
            status: status.status,
            url: (result.archiveKey ? presignKey(result.archiveKey) : null) || result.url || null,
            durable: result.durable ?? false,
            metadata: result.metadata || null,
            error: status.error,
        });
    } catch (error) {
        console.error('[upscale] status failed:', error);
        return json({ error: 'Could not load the upscale status.' }, 502);
    }
}
