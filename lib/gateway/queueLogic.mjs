// Pure queue policy (design §4): retry/backoff/timeout rules and the
// next-job pick (priority > org fairness > age, gated by concurrency caps).
// The processor turns the pick into an atomic UPDATE ... WHERE status='queued'.

export const MAX_ATTEMPTS = 3;

// Caps are env-tunable without a deploy of logic.
// ponytail: global caps; move onto projects/provider_routes rows if teams need per-entity tuning.
// Set high on purpose so the BytePlus account's own concurrent-task quota is
// the effective limiter — its 429s auto-retry with backoff (client + processor).
export const PROJECT_CONCURRENCY = Number(process.env.GATEWAY_PROJECT_CONCURRENCY || 50);
export const MODEL_CONCURRENCY = Number(process.env.GATEWAY_MODEL_CONCURRENCY || 50);
export const QUEUE_DEPTH_CAP = Number(process.env.GATEWAY_QUEUE_DEPTH_CAP || 500);

export function backoffDelayMs(attempt) {
    return 10_000 * 4 ** (Math.max(1, attempt) - 1); // 10s, 40s, 160s
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

// Pick the next runnable job. queued/running: job rows. Returns a job or null.
export function pickNextJob({ queued = [], running = [], now, pausedProjectIds = [] }) {
    const t = (now instanceof Date ? now : new Date(now)).getTime();
    const perProject = countBy(running, (j) => j.project_id);
    const perModel = countBy(running, (j) => j.model_id);
    const perOrg = countBy(running, (j) => j.org_id);

    const runnable = queued.filter((j) =>
        !pausedProjectIds.includes(j.project_id)
        && (!j.run_after || new Date(j.run_after).getTime() <= t)
        && (perProject[j.project_id] ?? 0) < PROJECT_CONCURRENCY
        && (perModel[j.model_id] ?? 0) < MODEL_CONCURRENCY);

    runnable.sort((a, b) =>
        priorityRank(a) - priorityRank(b)
        || (perOrg[a.org_id] ?? 0) - (perOrg[b.org_id] ?? 0)
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
