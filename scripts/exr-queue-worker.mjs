// Dedicated EXR queue worker.
// Run as a separate long-lived process: npm run worker:exr

import { getDb } from '../lib/db/neon.js';
import { archiveExr } from '../lib/byteplus/archiveExr.mjs';
import { pollEnhancement, submitEnhancement } from '../lib/byteplus/vodEnhance.mjs';
import {
    EXR_MAX_SUBMIT_ATTEMPTS,
    EXR_POLL_DELAY_MS,
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

async function runOne(sql) {
    const job = await claimNextExrJob(sql);
    if (!job) return false;

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
                await finishExrJob(sql, job.id, { status: 'failed', error: details });
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
            await rescheduleExrJob(sql, job.id, { delayMs: EXR_POLL_DELAY_MS });
        } else if (result.status === 'failed') {
            await finishExrJob(sql, job.id, { status: 'failed', error: { message: result.error || 'BytePlus EXR enhancement failed.' } });
        } else if (result.status === 'succeeded' && result.url) {
            const archived = await archiveExr({ url: result.url, taskId: job.provider_task_id });
            await finishExrJob(sql, job.id, {
                status: 'succeeded',
                result: {
                    url: archived.url,
                    archiveKey: archived.key,
                    durable: archived.durable,
                    bytes: archived.bytes || null,
                    archiveError: archived.archiveError || null,
                    metadata: result.metadata || null,
                    expiresAt: result.expiresAt || null,
                },
            });
        } else {
            await finishExrJob(sql, job.id, { status: 'failed', error: { message: 'BytePlus returned no EXR output URL.' } });
        }
    } catch (error) {
        const details = errorDetails(error);
        if (isPermanent(error)) {
            await finishExrJob(sql, job.id, { status: 'failed', error: details });
        } else {
            await rescheduleExrJob(sql, job.id, { delayMs: retryDelayMs(job.poll_attempt), error: details });
        }
    }
    return true;
}

export async function runExrQueue({ once = false } = {}) {
    const sql = await getDb();
    if (!sql) throw new Error('DATABASE_URL is not configured.');
    do {
        const worked = await runOne(sql);
        if (!worked && !once) await new Promise((resolve) => setTimeout(resolve, IDLE_DELAY_MS));
        if (once) return worked;
    } while (true);
}

if (process.argv[1]?.endsWith('exr-queue-worker.mjs')) {
    runExrQueue({ once: process.env.BYTEPLUS_EXR_WORKER_ONCE === 'true' })
        .catch((error) => { console.error(`[exr-worker] ${error.message}`); process.exitCode = 1; });
}
