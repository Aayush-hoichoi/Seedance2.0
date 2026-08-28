import test from 'node:test';
import assert from 'node:assert/strict';
import {
    backoffDelayMs, isRetryable, timeoutSecondsFor, pickNextJob, MAX_ATTEMPTS,
    PROJECT_CONCURRENCY, MODEL_CONCURRENCY, isStalledClaim, maxAttemptsFor,
    MAX_ATTEMPTS_NO_HANDLE, BACKOFF_CAP_MS,
} from '../lib/gateway/queueLogic.mjs';

const NOW = new Date('2026-07-11T12:00:00Z');

// --- retry policy ---------------------------------------------------------------

test('exponential backoff grows per attempt', () => {
    assert.equal(backoffDelayMs(1), 10_000);
    assert.equal(backoffDelayMs(2), 40_000);
});

test('backoff is capped so tail attempts stay a sane wait', () => {
    assert.equal(backoffDelayMs(3), BACKOFF_CAP_MS);
    assert.equal(backoffDelayMs(9), BACKOFF_CAP_MS);
});

// The whole point of the 4-attempt cap: a user must hear back well inside the
// 15 min the studio waits before it gives up with "Timed out waiting for the
// image". Bumping either the attempts or the backoff cap breaks this.
test('the no-handle ride-out stays inside its ~2 min backoff budget', () => {
    let total = 0;
    for (let a = 1; a < MAX_ATTEMPTS_NO_HANDLE; a += 1) total += backoffDelayMs(a);
    assert.ok(total <= 120_000, `retry backoff totals ${total}ms`);
});

test('MAX_ATTEMPTS is 3 per the PRD', () => {
    assert.equal(MAX_ATTEMPTS, 3);
});

// A Google 503 "high demand" spike outlasts 3 attempts. Nothing billable ran
// when there is no provider handle, so those jobs ride the spike out longer.
test('jobs with no provider handle get the longer retry ride-out', () => {
    assert.equal(maxAttemptsFor({}), MAX_ATTEMPTS_NO_HANDLE);
    assert.equal(maxAttemptsFor({ provider_task_id: 'kie-123' }), MAX_ATTEMPTS);
    assert.equal(maxAttemptsFor({ batch_job_name: 'batches/abc' }), MAX_ATTEMPTS);
    assert.ok(MAX_ATTEMPTS_NO_HANDLE > MAX_ATTEMPTS);
});

test('5xx/timeout/network errors retry; 4xx policy errors do not', () => {
    assert.equal(isRetryable({ status: 500 }), true);
    assert.equal(isRetryable({ status: 503 }), true);
    assert.equal(isRetryable({ code: 'ETIMEDOUT' }), true);
    assert.equal(isRetryable({ code: 'ECONNRESET' }), true);
    // Transport faults from undici: "fetch failed" must retry, not die at attempt 1.
    assert.equal(isRetryable({ code: 'ENETWORK' }), true);
    assert.equal(isRetryable({ code: 'UND_ERR_SOCKET' }), true);
    assert.equal(isRetryable({ code: 'UND_ERR_HEADERS_TIMEOUT' }), true);
    assert.equal(isRetryable({ status: 400 }), false);
    assert.equal(isRetryable({ status: 403 }), false);
    assert.equal(isRetryable({ status: 429 }), true); // provider rate limit: retry later
});

// --- timeouts --------------------------------------------------------------------

test('overdue job with no provider handle is a stalled claim (retry, not fail)', () => {
    // Interactive image job: settled inline, never got a task id / batch name.
    assert.equal(isStalledClaim({ provider_task_id: null, batch_job_name: null }), true);
    // Video task reached the provider — a real over-run, must time out.
    assert.equal(isStalledClaim({ provider_task_id: 'task-123', batch_job_name: null }), false);
    // Google batch reached the provider too.
    assert.equal(isStalledClaim({ provider_task_id: null, batch_job_name: 'batches/abc' }), false);
});

test('route timeout overrides class defaults', () => {
    assert.equal(timeoutSecondsFor({ category: 'image' }), 300);
    assert.equal(timeoutSecondsFor({ category: 'video' }), 1800);
    assert.equal(timeoutSecondsFor({ category: 'image', routeTimeoutSeconds: 86400 }), 86400);
});

// --- picking ----------------------------------------------------------------------

function job(id, over = {}) {
    return {
        id, project_id: 1, model_id: 'seedance-2.0',
        priority: 'interactive', created_at: '2026-07-11T11:00:00Z', run_after: null,
        ...over,
    };
}

test('interactive beats batch regardless of age', () => {
    const picked = pickNextJob({
        queued: [job(1, { priority: 'batch', created_at: '2026-07-11T09:00:00Z' }), job(2)],
        running: [], now: NOW,
    });
    assert.equal(picked.id, 2);
});

test('older job wins within the same priority', () => {
    const picked = pickNextJob({
        queued: [job(1, { created_at: '2026-07-11T10:00:00Z' }), job(2, { created_at: '2026-07-11T09:00:00Z' })],
        running: [], now: NOW,
    });
    assert.equal(picked.id, 2);
});

test('project fairness: project with fewer running jobs goes first', () => {
    const picked = pickNextJob({
        queued: [job(1, { project_id: 1 }), job(2, { project_id: 2, created_at: '2026-07-11T11:30:00Z' })],
        running: [job(90, { project_id: 1 }), job(91, { project_id: 1 })],
        now: NOW,
    });
    assert.equal(picked.id, 2); // younger, but its project has 0 running vs 2
});

test('per-project concurrency cap holds jobs back', () => {
    const running = Array.from({ length: PROJECT_CONCURRENCY }, (_, i) => job(900 + i)); // cap reached in project 1
    assert.equal(pickNextJob({ queued: [job(1)], running, now: NOW }), null);
    // Different model so only the project dimension binds (caps may be equal).
    const other = pickNextJob({ queued: [job(1), job(2, { project_id: 2, model_id: 'seedance-2.0-mini' })], running, now: NOW });
    assert.equal(other.id, 2);
});

test('per-model provider cap holds jobs back', () => {
    const running = Array.from({ length: MODEL_CONCURRENCY }, (_, i) => job(800 + i, { project_id: 100 + i }));
    assert.equal(pickNextJob({ queued: [job(1, { project_id: 50 })], running, now: NOW }), null);
});

test('paused projects and future run_after are skipped', () => {
    assert.equal(pickNextJob({ queued: [job(1)], running: [], now: NOW, pausedProjectIds: [1] }), null);
    assert.equal(pickNextJob({ queued: [job(1, { run_after: '2026-07-11T13:00:00Z' })], running: [], now: NOW }), null);
    assert.equal(pickNextJob({ queued: [job(1, { run_after: '2026-07-11T11:59:00Z' })], running: [], now: NOW }).id, 1);
});
