// Queue processor (design §4): claim → submit via provider routing (with
// failover) → poll → settle billing → emit events → alert thresholds.
// Runs inside waitUntil() after enqueue and from the guarded sweep — each
// pass is bounded so it always fits a serverless invocation.

import { getDb } from '../db/neon.js';
import {
    resolveRouting, resolveApiKey, queueState, claimJob, finishJob, requeueJob,
    markSubmitted, insertBillingEvent, emitEvent, activeQuotas, usageForQuotas,
} from './db.js';
import { pickNextJob, backoffDelayMs, isRetryable, timeoutSecondsFor, MAX_ATTEMPTS } from './queueLogic.mjs';
import { thresholdsCrossed, applicableQuotas, unitsForType, windowBounds } from './quota.mjs';
import { costFromTokens } from '../seedance/pricing.mjs';
import { imageCost, imageRate } from './imagePricing.mjs';
import { storeImages } from './storage.mjs';
import { archiveVideo } from '../seedance/archiveVideo.mjs';
import { checkSpendAlert } from './spendAlerts.mjs';
import * as byteplus from './providers/byteplus.mjs';
import * as google from './providers/google.mjs';

const CLAIMS_PER_PASS = 3;
const POLL_BUDGET_MS = 45_000; // stay well inside one invocation

export async function processQueue() {
    const sql = await getDb();
    if (!sql) return;
    for (let i = 0; i < CLAIMS_PER_PASS; i += 1) {
        const state = await queueState(sql);
        const pick = pickNextJob({ ...state, now: new Date() });
        if (!pick) break;
        const routing = await resolveRouting(sql, pick.model_id);
        if (!routing || !routing.routes.length) {
            const job = await claimJob(sql, pick.id, { timeoutAt: new Date() });
            if (job) await settleFailure(sql, job, { status: 400, message: 'No active provider route for this model.' });
            continue;
        }
        const timeoutAt = new Date(Date.now() + timeoutSecondsFor({
            category: routing.model.category,
            routeTimeoutSeconds: routing.routes[0].timeout_seconds,
        }) * 1000);
        const job = await claimJob(sql, pick.id, { timeoutAt });
        if (!job) continue; // lost the race to another instance
        // Google image models run interactively (synchronous generateContent) —
        // the async Batch API was removed as too slow for the studio. Everything
        // else (BytePlus video + Seedream image) takes the failover path.
        if (routing.routes[0].provider_id === 'google') {
            await runGoogleInteractive(sql, job, routing);
        } else {
            await runWithFailover(sql, job, routing);
        }
    }
    await pollRunningJobs();
}

// Try each active route in priority order; failover on retryable errors only.
async function runWithFailover(sql, job, routing) {
    let lastError = { status: 500, message: 'no route attempted' };
    for (const route of routing.routes) {
        const auth = await resolveApiKey(sql, { providerId: route.provider_id, projectId: job.project_id });
        if (!auth) { lastError = { status: 500, message: `No API key for ${route.provider_id}` }; continue; }
        const routeCtx = { ...route, category: routing.model.category };
        const r = await byteplus.submit({ job, route: routeCtx, apiKey: auth.key });
        if (r.ok && r.done) { // sync image result
            return settleSuccess(sql, job, {
                route, apiKeyId: auth.apiKeyId, result: r.result, usage: r.usage, kind: routing.version.kind,
            });
        }
        if (r.ok && r.providerTaskId) {
            await markSubmitted(sql, job.id, { providerId: route.provider_id, providerTaskId: r.providerTaskId });
            await emitEvent(sql, { projectId: job.project_id, userId: job.user_id, type: 'job.status_changed', payload: { jobId: job.id, status: 'running' } });
            return pollUntilBudget(sql, { ...job, provider_id: route.provider_id, provider_task_id: r.providerTaskId }, routing, auth);
        }
        lastError = r.error || lastError;
        if (!isRetryable(lastError)) break; // bad input / policy: no failover helps
    }
    return retryOrFail(sql, job, lastError);
}

// Google image: one synchronous generateContent call, settle immediately —
// seconds, not the minutes the Batch API took. A missing key isn't transient,
// so fail fast (status 400 = terminal) with an actionable message.
async function runGoogleInteractive(sql, job, routing) {
    const route = routing.routes[0];
    const auth = await resolveApiKey(sql, { providerId: 'google', projectId: job.project_id });
    if (!auth) return settleFailure(sql, job, { status: 400, message: 'Image generation needs a Google API key — set GOOGLE_API_KEY for the “google” provider.' });
    const r = await google.submit({ job, providerModelId: route.provider_model_id, apiKey: auth.key });
    if (r.ok && r.done) {
        return settleSuccess(sql, job, { route, apiKeyId: auth.apiKeyId, result: r.result, usage: r.usage, kind: routing.version.kind });
    }
    return retryOrFail(sql, job, r.error || { status: 400, message: 'generation failed' });
}

// Poll a fresh video task inside this invocation's budget; the sweep resumes
// polling on later traffic if the task outlives it.
async function pollUntilBudget(sql, job, routing, auth) {
    const deadline = Date.now() + POLL_BUDGET_MS;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5_000));
        const p = await byteplus.poll({ job, apiKey: auth.key });
        if (p.ok && p.done) {
            if (p.status === 'succeeded') {
                return settleSuccess(sql, job, { route: routing.routes[0], apiKeyId: auth.apiKeyId, result: p.result, usage: p.usage, kind: routing.version.kind });
            }
            return retryOrFail(sql, job, p.error || { status: 400, message: 'generation failed' });
        }
        if (!p.ok && !isRetryable(p.error)) return retryOrFail(sql, job, p.error);
    }
}

// Re-poll everything already running (video tasks + google batches).
export async function pollRunningJobs() {
    const sql = await getDb();
    if (!sql) return;
    const running = await sql`SELECT * FROM jobs WHERE status = 'running' AND (provider_task_id IS NOT NULL OR batch_job_name IS NOT NULL) LIMIT 50`;

    const batches = new Map(); // batch_job_name → jobs[]
    for (const job of running) {
        if (job.batch_job_name) {
            const list = batches.get(job.batch_job_name) || [];
            list.push(job);
            batches.set(job.batch_job_name, list);
            continue;
        }
        const routing = await resolveRouting(sql, job.model_id);
        const auth = routing && await resolveApiKey(sql, { providerId: job.provider_id, projectId: job.project_id });
        if (!auth) continue;
        const p = await byteplus.poll({ job, apiKey: auth.key });
        if (p.ok && p.done) {
            if (p.status === 'succeeded') await settleSuccess(sql, job, { route: routing.routes[0] || {}, apiKeyId: auth.apiKeyId, result: p.result, usage: p.usage, kind: routing.version.kind });
            else await retryOrFail(sql, job, p.error || { status: 400, message: 'generation failed' });
        }
    }

    for (const [batchName, jobs] of batches) {
        const first = jobs[0];
        const routing = await resolveRouting(sql, first.model_id);
        const auth = routing && await resolveApiKey(sql, { providerId: 'google', projectId: first.project_id });
        if (!auth) continue;
        const p = await google.pollBatch({ batchName, apiKey: auth.key });
        if (!p.ok || !p.done) continue;
        for (const job of jobs) {
            const item = p.byKey[String(job.id)];
            if (item?.images) {
                await settleSuccess(sql, job, { route: routing.routes[0], apiKeyId: auth.apiKeyId, result: { images: item.images }, usage: null, kind: routing.version.kind, mode: 'batch' });
            } else {
                await retryOrFail(sql, job, item?.error || { status: 400, message: 'missing batch response' });
            }
        }
    }
}

// --- settlement ---------------------------------------------------------------

async function settleSuccess(sql, job, { route, apiKeyId, result, usage, kind, mode }) {
    const req = { ...(job.request_body || {}), ...(job.request_body?.options || {}) };
    const images = result?.images ? await storeImages(job.id, result.images) : null;
    let finalResult = images ? { images } : result;

    // Persist the video to our own TOS bucket now, while the provider URL is
    // fresh (it dies in ~24h) — this is the ONLY reliable capture point: the
    // browser's fire-and-forget archive misses closed tabs and every MCP
    // generation. Best-effort: a failure here must never block settlement/
    // billing, and the provider URL + browser fallback still stand.
    if (!images && result?.video_url && job.provider_task_id) {
        try {
            const { key } = await archiveVideo({ url: result.video_url, taskId: job.provider_task_id });
            finalResult = { ...result, video_key: key };
        } catch (err) {
            console.error(`[archive] job ${job.id} video archive failed:`, err.message);
        }
    }

    let costUsd = null;
    let units = null;
    let snapshot = null;
    if (!images && usage?.completion_tokens != null) { // video only: images never take the token-cost branch
        costUsd = costFromTokens(kind, req.resolution, !!req.has_video_input, usage.completion_tokens);
        units = { video_seconds: req.duration > 0 ? req.duration : 5, completion_tokens: usage.completion_tokens };
        snapshot = { basis: 'tokens', kind, resolution: req.resolution };
    } else if (images) {
        const routeMode = mode || route.mode || 'interactive';
        costUsd = imageCost(kind, routeMode, images.length, req.imageSize);
        units = { images: images.length };
        snapshot = { basis: 'per_image', kind, mode: routeMode, imageSize: req.imageSize ?? null, rate: imageRate(kind, routeMode, req.imageSize) };
    }

    const finished = await finishJob(sql, job.id, { status: 'succeeded', result: finalResult, providerId: route.provider_id });
    if (!finished) return; // already settled elsewhere (e.g. cancel raced)
    await insertBillingEvent(sql, {
        eventType: 'settlement', generationId: job.id, projectId: job.project_id,
        userId: job.user_id, modelId: job.model_id, modelVersionId: job.model_version_id,
        providerId: route.provider_id, apiKeyId, units, estCostUsd: req.est_cost_usd ?? null,
        costUsd, pricingSnapshot: snapshot,
    });
    await emitEvent(sql, { projectId: job.project_id, userId: job.user_id, type: 'job.status_changed', payload: { jobId: job.id, status: 'succeeded', costUsd } });
    await checkThresholds(sql, job, { costUsd, units });
    await checkSpendAlert(sql); // "burning money" WhatsApp alert on each $500 milestone (best-effort, self-guarded)
}

async function settleFailure(sql, job, error) {
    const finished = await finishJob(sql, job.id, { status: 'failed', error });
    if (!finished) return;
    await insertBillingEvent(sql, {
        eventType: 'failure', generationId: job.id, projectId: job.project_id,
        userId: job.user_id, modelId: job.model_id, modelVersionId: job.model_version_id,
        providerId: job.provider_id, units: null, costUsd: null, estCostUsd: null,
        pricingSnapshot: null,
    });
    await emitEvent(sql, { projectId: job.project_id, userId: job.user_id, type: 'job.status_changed', payload: { jobId: job.id, status: 'failed', error: error?.message || null } });
}

async function retryOrFail(sql, job, error) {
    if (job.attempt < MAX_ATTEMPTS && isRetryable(error)) {
        await requeueJob(sql, job.id, { runAfterMs: backoffDelayMs(job.attempt), error });
        await emitEvent(sql, { projectId: job.project_id, userId: job.user_id, type: 'job.status_changed', payload: { jobId: job.id, status: 'queued', retry: job.attempt } });
        return;
    }
    await settleFailure(sql, job, error);
}

// After a settlement, emit budget.threshold_crossed once per (quota, window,
// threshold) — deduped by quota_alerts_sent.
async function checkThresholds(sql, job, { costUsd, units }) {
    const quotas = applicableQuotas(await activeQuotas(sql), { projectId: job.project_id, userId: job.user_id, modelId: job.model_id });
    if (!quotas.length) return;
    const { usedByQuota } = await usageForQuotas(sql, quotas);
    const estimate = { usd: costUsd ?? 0, images: units?.images ?? 0, video_seconds: units?.video_seconds ?? 0, requests: 1 };
    for (const quota of quotas) {
        const after = usedByQuota[quota.id] ?? 0;
        const before = after - unitsForType(quota.type, estimate);
        for (const threshold of thresholdsCrossed(quota, before, after)) {
            const windowStart = windowBounds(quota.window, new Date()).start.toISOString().slice(0, 10);
            const [inserted] = await sql`INSERT INTO quota_alerts_sent (quota_id, window_start, threshold)
                VALUES (${quota.id}, ${windowStart}, ${threshold})
                ON CONFLICT DO NOTHING RETURNING quota_id`;
            if (inserted) {
                await emitEvent(sql, {
                    projectId: quota.project_id, userId: quota.user_id,
                    type: 'budget.threshold_crossed',
                    payload: { quotaId: quota.id, threshold, window: quota.window, type: quota.type, modelId: quota.model_id ?? null, limit: Number(quota.hard_limit), used: after },
                });
            }
        }
    }
}

export { settleSuccess, settleFailure, retryOrFail };
