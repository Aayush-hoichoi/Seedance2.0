// Pure queue policy (design §4): retry/backoff/timeout rules and the
// next-job pick (priority > project fairness > age, gated by concurrency caps).
// The processor turns the pick into an atomic UPDATE ... WHERE status='queued'.

export const MAX_ATTEMPTS = 3;

// Caps are env-tunable without a deploy of logic.
// ponytail: global caps; move onto projects/provider_routes rows if teams need per-entity tuning.
// Set high on purpose so the BytePlus account's own concurrent-task quota is
// the effective limiter — its 429s auto-retry with backoff (client + processor).
export const PROJECT_CONCURRENCY = Number(process.env.GATEWAY_PROJECT_CONCURRENCY || 50);
export const MODEL_CONCURRENCY = Number(process.env.GATEWAY_MODEL_CONCURRENCY || 50);
export const QUEUE_DEPTH_CAP = Number(process.env.GATEWAY_QUEUE_DEPTH_CAP || 500);

// Capped so the tail attempts stay a sane wait rather than 4**n hours.
// 10s, 40s, 160s, then 600s per attempt.
export const BACKOFF_CAP_MS = Number(process.env.GATEWAY_BACKOFF_CAP_MS || 600_000);
export function backoffDelayMs(attempt) {
    return Math.min(10_000 * 4 ** (Math.max(1, attempt) - 1), BACKOFF_CAP_MS);
}

// Google's image models answer a capacity spike with 503 "This model is
// currently experiencing high demand" — Nano Banana Pro most of all, since
// preview models get a small fixed compute pool. Those spikes routinely
// outlast MAX_ATTEMPTS (~3.5 min of backoff), so the user sees a failure for
// something that would have worked minutes later.
//
// Only jobs with NO provider handle get the longer ride-out: nothing billable
// ran upstream, so re-submitting is free. A job that DID reach a provider
// keeps the 3-attempt cap — every retry there risks paying for the same
// generation twice.
export const MAX_ATTEMPTS_NO_HANDLE = Number(process.env.GATEWAY_MAX_ATTEMPTS_NO_HANDLE || 6);
export function maxAttemptsFor(job = {}) {
    return hasProviderHandle(job) ? MAX_ATTEMPTS : MAX_ATTEMPTS_NO_HANDLE; // 6 attempts ≈ 23 min
}

// Provider 5xx / rate limits / network faults retry; 4xx (bad input, content
// policy, auth) fail immediately per PRD §9.1.
export function isRetryable(error = {}) {
    if (error.status === 429) return true;
    if (typeof error.status === 'number') return error.status >= 500;
    return ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(error.code);
}

export function timeoutSecondsFor({ category, routeTimeoutSeconds }) {
    if (routeTimeoutSeconds) return routeTimeoutSeconds;
    return category === 'video' ? 1800 : 300;
}

// A 'running' job past its deadline with NO provider handle (no video task id,
// no google batch) never actually reached a provider we can resume — its
// claiming invocation died mid-call (the interactive image path settles inline,
// so pollRunningJobs, which is handle-only, can't pick it up). Retry it on a
// fresh invocation rather than fail. A job that DID reach a provider genuinely
// ran over its deadline and should time out.
export function isStalledClaim(job = {}) {
    return !hasProviderHandle(job);
}

// A video task id or a google batch name: proof the job reached a provider.
export function hasProviderHandle(job = {}) {
    return Boolean(job.provider_task_id || job.batch_job_name);
}

// Pick the next runnable job. queued/running: job rows. Returns a job or null.
export function pickNextJob({ queued = [], running = [], now, pausedProjectIds = [] }) {
    const t = (now instanceof Date ? now : new Date(now)).getTime();
    const perProject = countBy(running, (j) => j.project_id);
    const perModel = countBy(running, (j) => j.model_id);

    const runnable = queued.filter((j) =>
        !pausedProjectIds.includes(j.project_id)
        && (!j.run_after || new Date(j.run_after).getTime() <= t)
        && (perProject[j.project_id] ?? 0) < PROJECT_CONCURRENCY
        && (perModel[j.model_id] ?? 0) < MODEL_CONCURRENCY);

    // Fairness tiebreak: prefer the project with the fewest jobs already
    // running so one busy project can't starve the others (was per-org).
    runnable.sort((a, b) =>
        priorityRank(a) - priorityRank(b)
        || (perProject[a.project_id] ?? 0) - (perProject[b.project_id] ?? 0)
        || new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    return runnable[0] ?? null;
}

function priorityRank(job) {
    return job.priority === 'interactive' ? 0 : 1;
}

function countBy(rows, keyFn) {
    const out = {};
    for (const r of rows) {
        const k = keyFn(r);
        out[k] = (out[k] ?? 0) + 1;
    }
    return out;
}
