// Dedicated EXR queue worker.
// Run as a separate long-lived process: npm run worker:exr

import { getDb } from '../lib/db/neon.js';
import { archiveExr } from '../lib/byteplus/archiveExr.mjs';
import { estimateUpscaleCost } from '../lib/byteplus/upscaleOptions.mjs';
import { estimateExrCost } from '../lib/byteplus/exrPricing.mjs';
import { closeToolSpend } from '../lib/tools/billing.mjs';
import { pollEnhancement, submitEnhancement } from '../lib/byteplus/vodEnhance.mjs';
import {
    EXR_MAX_SUBMIT_ATTEMPTS,
    EXR_POLL_DELAY_MS,
    claimNextArchiveUpgrade,
    claimNextExrJob,
    finishExrJob,
    markExrSubmitted,
    rescheduleExrJob,
} from '../lib/byteplus/exrQueue.mjs';

const IDLE_DELAY_MS = Number(process.env.BYTEPLUS_EXR_WORKER_IDLE_MS) || 1_000;

function errorDetails(error) {
    return {
        message: error?.message || 'EXR worker error.',
        status: error?.status || null,
        code: error?.code || null,
    };
}

function retryDelayMs(attempt) {
    return Math.min(60_000, 5_000 * 2 ** Math.max(0, Math.min(attempt, 5)));
}

function isPermanent(error) {
    return Number.isFinite(error?.status) && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

// Every terminal transition goes through here so a budgeted tool job's
// reservation is always closed (settled on success, zero-cost failure otherwise).
async function finish(sql, job, outcome) {
    const row = await finishExrJob(sql, job.id, outcome);
    if (!row) return null; // someone else (cancel) already finished it
    try {
        if (outcome.status === 'succeeded') {
            const up = row.request_body?._upscale;
            const b = row.request_body?._billing;
            const seconds = Number(outcome.result?.metadata?.duration) || Number(up?.source?.seconds) || Number(b?.durationSeconds) || null;
            // Settle on the provider-reported duration, not the client's
            // estimate — an understated submit-time duration is corrected here.
            const cost = up ? estimateUpscaleCost(up.options, { ...up.source, seconds })
                : estimateExrCost({ tier: b?.tier, resolution: b?.resolution, fps: b?.fps }, seconds);
            await closeToolSpend(sql, row, 'settlement', { costUsd: cost ?? b?.estimatedCostUsd ?? null, seconds });
        } else {
            await closeToolSpend(sql, row, 'failure');
        }
    } catch (error) {
        console.error(`[exr-worker] billing close failed for job ${row.id}:`, error.message);
    }
    return row;
}

// Copy a finished job's provider output into durable TOS storage and swap the
// stored URL. Runs AFTER the job is already succeeded: a crash or serverless
// kill here loses nothing — the lease lapses and a later pass retries.
async function upgradeArchive(sql, job) {
    const src = job.result || {};
    if (!src.url) return;
    try {
        const up = job.request_body?._upscale;
        const safeId = String(job.provider_task_id).replace(/[^a-zA-Z0-9._-]/g, '_');
        const archived = await archiveExr(up
            ? { url: src.url, taskId: job.provider_task_id, key: `upscale/${safeId}.${up.container}`, contentType: up.container === 'mov' ? 'video/quicktime' : 'video/mp4' }
            : { url: src.url, taskId: job.provider_task_id });
        await sql`UPDATE exr_jobs
            SET result = ${JSON.stringify({
                ...src,
                url: archived.url,
                archiveKey: archived.key,
                durable: archived.durable,
                bytes: archived.bytes || null,
                archiveError: archived.archiveError || null,
            })}, lease_until = NULL, updated_at = now()
            WHERE id = ${job.id} AND status = 'succeeded'`;
    } catch (error) {
        // ponytail: count attempts so a job whose output can't be copied stops
        // burning bandwidth after 5 tries; a TOS fetch-from-URL task (copy
        // inside BytePlus's network) is the upgrade path for multi-GB outputs.
        console.error(`[exr-worker] archive upgrade failed for job ${job.id}:`, error.message);
        await sql`UPDATE exr_jobs
            SET result = ${JSON.stringify({ ...src, archiveAttempts: (Number(src.archiveAttempts) || 0) + 1 })},
                lease_until = NULL, updated_at = now()
            WHERE id = ${job.id} AND status = 'succeeded'`.catch(() => { /* next pass recounts */ });
    }
}

// A crash between the 'reserving' insert and the queued flip strands a job
// holding budget the client never got an id for. Never run it later — reject
// it and release the reservation (closeToolSpend is exactly-once).
async function recoverStaleExrReservations(sql) {
    const stale = await sql`UPDATE exr_jobs
        SET status = 'rejected', finished_at = now(), updated_at = now(),
            error = ${JSON.stringify({ message: 'Submission was interrupted before it completed.' })}
        WHERE status = 'reserving' AND created_at < now() - interval '2 minutes'
        RETURNING *`;
    for (const job of stale) {
        try { await closeToolSpend(sql, job, 'release'); } catch (error) {
            console.error(`[exr-worker] release failed for stale job ${job.id}:`, error.message);
        }
    }
}

async function runOne(sql) {
    const job = await claimNextExrJob(sql);
    if (!job) {
        // No active work: heal one succeeded job whose durable copy is still
        // pending (its earlier upgrade attempt was killed mid-transfer).
        const pending = await claimNextArchiveUpgrade(sql);
        if (!pending) return false;
        await upgradeArchive(sql, pending);
        return true;
    }

    if (!job.provider_task_id) {
        try {
            const submitted = await submitEnhancement({ videoUrl: job.source_url, requestBody: job.request_body });
            await markExrSubmitted(sql, job.id, {
                providerTaskId: submitted.taskId,
                requestId: submitted.requestId,
            });
        } catch (error) {
            const details = errorDetails(error);
            if (isPermanent(error) || job.attempt >= EXR_MAX_SUBMIT_ATTEMPTS) {
                await finish(sql, job, { status: 'failed', error: details });
            } else {
                await rescheduleExrJob(sql, job.id, { delayMs: retryDelayMs(job.attempt), error: details });
            }
        }
        return true;
    }

    try {
        const result = job.result?.url
            ? { status: 'succeeded', url: job.result.url, metadata: job.result.metadata || null, expiresAt: job.result.expiresAt || null }
            : await pollEnhancement(job.provider_task_id);
        if (result.status === 'processing') {
            // Stash a provider-reported percent (if BytePlus ever sends one)
            // where the status route can read it; finish() overwrites result
            // on the terminal states, so this never pollutes the archive.
            if (result.progress != null) {
                await sql`UPDATE exr_jobs SET result = ${JSON.stringify({ progress: result.progress })}, updated_at = now()
                    WHERE id = ${job.id} AND status = 'processing'`;
            }
            await rescheduleExrJob(sql, job.id, { delayMs: EXR_POLL_DELAY_MS });
        } else if (result.status === 'failed') {
            await finish(sql, job, { status: 'failed', error: { message: result.error || 'BytePlus EXR enhancement failed.' } });
        } else if (result.status === 'succeeded' && result.url) {
            // Reflect success IMMEDIATELY with the provider's own URL. The
            // durable copy of a multi-GB output can outlive a serverless
            // invocation (EXR-7 sat "processing" for an hour after BytePlus
            // finished because the killed copy restarted forever) — so the
            // archive is a background upgrade, never a gate on "done".
            const finished = await finish(sql, job, {
                status: 'succeeded',
                result: { url: result.url, durable: false, metadata: result.metadata || null, expiresAt: result.expiresAt || null },
            });
            if (finished) await upgradeArchive(sql, { ...job, result: { url: result.url, metadata: result.metadata || null, expiresAt: result.expiresAt || null } });
        } else {
            await finish(sql, job, { status: 'failed', error: { message: 'BytePlus returned no EXR output URL.' } });
        }
    } catch (error) {
        const details = errorDetails(error);
        if (isPermanent(error)) {
            await finish(sql, job, { status: 'failed', error: details });
        } else {
            await rescheduleExrJob(sql, job.id, { delayMs: retryDelayMs(job.poll_attempt), error: details });
        }
    }
    return true;
}

export async function runExrQueue({ once = false } = {}) {
    const sql = await getDb();
    if (!sql) throw new Error('DATABASE_URL is not configured.');
    await recoverStaleExrReservations(sql).catch(() => { /* next pass retries */ });
    do {
        const worked = await runOne(sql);
        if (!worked && !once) await new Promise((resolve) => setTimeout(resolve, IDLE_DELAY_MS));
        if (once) return worked;
    } while (true);
}

// Work the queue until every EXR job is terminal or the time budget runs out.
// A single once-pass only advances a job one step, so with no long-lived
// worker a job used to freeze in 'processing' the moment the browser stopped
// polling the status route (EXR-4 sat "processing" for 20 minutes after
// BytePlus had already finished). The submit route drains after responding,
// and the daily cron drains as the safety net for anything that outlives it.
export async function drainExrQueue({ maxMs = 240_000 } = {}) {
    const sql = await getDb();
    if (!sql) throw new Error('DATABASE_URL is not configured.');
    await recoverStaleExrReservations(sql).catch(() => { /* next drain retries */ });
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        const worked = await runOne(sql);
        if (!worked) {
            const [pending] = await sql`SELECT count(*)::int AS n FROM exr_jobs WHERE status IN ('queued', 'processing')`;
            if (!pending?.n) return;
            await new Promise((resolve) => setTimeout(resolve, IDLE_DELAY_MS));
        }
    }
}

if (process.argv[1]?.endsWith('exr-queue-worker.mjs')) {
    runExrQueue({ once: process.env.BYTEPLUS_EXR_WORKER_ONCE === 'true' })
        .catch((error) => { console.error(`[exr-worker] ${error.message}`); process.exitCode = 1; });
}
