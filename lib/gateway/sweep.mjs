// Guarded maintenance sweep (design §0 free-plan fit): piggybacks on SSE
// ticks and API traffic instead of a per-minute cron. The gateway_state row
// makes it run at most ~once/min across ALL serverless instances.

import { getDb } from '../db/neon.js';
import { emitEvent, insertBillingEvent, finishJob, requeueJob } from './db.js';
import { effectiveAccess } from './access.mjs';
import { cancelJob } from './cancel.mjs';
import { processQueue, pollRunningJobs } from './processor.mjs';
import { isStalledClaim, MAX_ATTEMPTS } from './queueLogic.mjs';

export async function sweep({ force = false } = {}) {
    const sql = await getDb();
    if (!sql) return false;

    if (!force) {
        const [claimed] = await sql`INSERT INTO gateway_state (key, value, updated_at)
            VALUES ('last_sweep', '{}', now())
            ON CONFLICT (key) DO UPDATE SET updated_at = now()
            WHERE gateway_state.updated_at < now() - interval '55 seconds'
            RETURNING key`;
        if (!claimed) return false; // someone swept within the last minute
    }

    await recoverStaleReservations(sql);
    await timeOutOverdueJobs(sql);
    await pushExpiries(sql);
    await pollRunningJobs();
    await processQueue();
    return true;
}

// enqueueGeneration deliberately parks a job in `reserving` while the
// authoritative quota transaction runs. A serverless invocation can disappear
// between those commits, so recover both possible durable states: a completed
// reservation is safe to queue, while a job with no reservation is failed and
// consumes no budget.
export async function recoverStaleReservations(sql) {
    const stale = await sql`SELECT * FROM jobs
        WHERE status = 'reserving' AND created_at < now() - interval '2 minutes'
        ORDER BY created_at ASC LIMIT 25`;
    for (const job of stale) {
        const [reservation] = await sql`SELECT id FROM billing_events r
            WHERE r.generation_id = ${String(job.id)} AND r.event_type = 'reservation'
              AND NOT EXISTS (SELECT 1 FROM billing_events done
                  WHERE done.generation_id = r.generation_id
                    AND done.event_type IN ('settlement', 'failure', 'release'))
            LIMIT 1`;
        if (reservation) {
            const [queued] = await sql`UPDATE jobs SET status = 'queued'
                WHERE id = ${job.id} AND status = 'reserving' RETURNING id`;
            if (queued) await emitEvent(sql, {
                projectId: job.project_id, userId: job.user_id,
                type: 'job.status_changed', payload: { jobId: job.id, status: 'queued', recovered: true },
            });
            continue;
        }
        await sql`UPDATE jobs SET status = 'failed', finished_at = now(),
            error = ${JSON.stringify({ message: 'Budget reservation was interrupted before it committed.' })}
            WHERE id = ${job.id} AND status = 'reserving'`;
    }
}

async function timeOutOverdueJobs(sql) {
    const overdue = await sql`SELECT * FROM jobs WHERE status = 'running' AND timeout_at IS NOT NULL AND timeout_at < now() LIMIT 25`;
    for (const job of overdue) {
        // Stranded interactive job (invocation died before it settled): retry on
        // a fresh invocation instead of failing, up to MAX_ATTEMPTS. processQueue
        // (run later in this same sweep) re-claims it immediately.
        if (isStalledClaim(job) && job.attempt < MAX_ATTEMPTS) {
            await requeueJob(sql, job.id, { runAfterMs: 0, error: { message: 'attempt interrupted — retrying' } });
            await emitEvent(sql, { projectId: job.project_id, userId: job.user_id, type: 'job.status_changed', payload: { jobId: job.id, status: 'queued', retry: job.attempt } });
            continue;
        }
        const finished = await finishJob(sql, job.id, { status: 'timed_out', error: { message: 'generation timed out' } });
        if (!finished) continue;
        await insertBillingEvent(sql, {
            eventType: 'failure', generationId: job.id, projectId: job.project_id,
            userId: job.user_id, modelId: job.model_id, modelVersionId: job.model_version_id,
            providerId: job.provider_id, units: null, estCostUsd: null, costUsd: null, pricingSnapshot: null,
        });
        await emitEvent(sql, { projectId: job.project_id, userId: job.user_id, type: 'job.status_changed', payload: { jobId: job.id, status: 'timed_out' } });
    }
}

// Push access.expired the moment a grant/override window closes, and cancel
// queued jobs the expiry actually de-authorizes (re-checked via the same
// pure decision the gateway enforces with).
async function pushExpiries(sql) {
    const grants = await sql`SELECT g.* FROM project_model_grants g
        JOIN projects p ON p.id = g.project_id
        WHERE g.valid_until IS NOT NULL AND g.valid_until < now() AND g.revoked_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.type = 'access.expired' AND e.payload->>'grantId' = g.id::text)
        LIMIT 25`;
    for (const g of grants) {
        await emitEvent(sql, { projectId: g.project_id, type: 'access.expired', payload: { grantId: g.id, modelId: g.model_id, scope: 'project' } });
        await cancelDeauthorizedQueued(sql, { projectId: g.project_id, modelId: g.model_id });
    }

    const overrides = await sql`SELECT o.* FROM user_model_overrides o
        JOIN projects p ON p.id = o.project_id
        WHERE o.valid_until IS NOT NULL AND o.valid_until < now() AND o.revoked_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.type = 'access.expired' AND e.payload->>'overrideId' = o.id::text)
        LIMIT 25`;
    for (const o of overrides) {
        await emitEvent(sql, { projectId: o.project_id, userId: o.user_id, type: 'access.expired', payload: { overrideId: o.id, modelId: o.model_id, effect: o.effect, scope: 'user' } });
        if (o.effect === 'allow') await cancelDeauthorizedQueued(sql, { projectId: o.project_id, modelId: o.model_id, userId: o.user_id });
    }
}

export async function cancelDeauthorizedQueued(sql, { projectId, modelId, userId = null }) {
    const queued = await sql`SELECT * FROM jobs
        WHERE status = 'queued' AND project_id = ${projectId} AND model_id = ${modelId}
          AND (${userId}::text IS NULL OR user_id = ${userId})`;
    if (!queued.length) return;
    const grants = await sql`SELECT * FROM project_model_grants WHERE project_id = ${projectId}`;
    const defaults = (await sql`SELECT id FROM models WHERE is_default = true AND active = true`).map((m) => m.id);
    for (const job of queued) {
        const overrides = await sql`SELECT * FROM user_model_overrides WHERE project_id = ${projectId} AND user_id = ${job.user_id}`;
        const { allowed } = effectiveAccess({ modelId, now: new Date(), overrides, grants, defaultModelIds: defaults });
        if (!allowed) await cancelJob(sql, job, { reason: 'access expired or revoked' });
    }
}
