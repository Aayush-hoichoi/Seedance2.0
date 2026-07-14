import test from 'node:test';
import assert from 'node:assert/strict';
import {
    backoffDelayMs, isRetryable, timeoutSecondsFor, pickNextJob, MAX_ATTEMPTS,
    PROJECT_CONCURRENCY, MODEL_CONCURRENCY,
} from '../lib/gateway/queueLogic.mjs';

const NOW = new Date('2026-07-11T12:00:00Z');

// --- retry policy ---------------------------------------------------------------

test('exponential backoff grows per attempt', () => {
    assert.equal(backoffDelayMs(1), 10_000);
    assert.equal(backoffDelayMs(2), 40_000);
    assert.equal(backoffDelayMs(3), 160_000);
});

test('MAX_ATTEMPTS is 3 per the PRD', () => {
    assert.equal(MAX_ATTEMPTS, 3);
});

test('5xx/timeout/network errors retry; 4xx policy errors do not', () => {
    assert.equal(isRetryable({ status: 500 }), true);
    assert.equal(isRetryable({ status: 503 }), true);
    assert.equal(isRetryable({ code: 'ETIMEDOUT' }), true);
    assert.equal(isRetryable({ code: 'ECONNRESET' }), true);
    assert.equal(isRetryable({ status: 400 }), false);
    assert.equal(isRetryable({ status: 403 }), false);
    assert.equal(isRetryable({ status: 429 }), true); // provider rate limit: retry later
});

// --- timeouts --------------------------------------------------------------------

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
