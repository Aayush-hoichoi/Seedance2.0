import test from 'node:test';
import assert from 'node:assert/strict';
import { exrProgress } from '../lib/byteplus/exrProgress.mjs';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const MIN = 60_000;

test('queued jobs report a real queue position and an empty bar', () => {
    const p = exrProgress({ status: 'queued' }, { queueAhead: 2, typicalMs: 4 * MIN, now: NOW });
    assert.equal(p.stage, 'queued');
    assert.equal(p.queuePosition, 3);
    assert.equal(p.fraction, 0);
});

test('processing without a provider task is "submitting" with a sliver of progress', () => {
    const p = exrProgress({ status: 'processing', provider_task_id: null }, { now: NOW });
    assert.equal(p.stage, 'submitting');
    assert.ok(p.fraction > 0 && p.fraction < 0.1);
});

test('enhancing estimates the bar from elapsed vs the historical median, capped below done', () => {
    const job = { status: 'processing', provider_task_id: 't1', started_at: new Date(NOW - 2 * MIN).toISOString() };
    const half = exrProgress(job, { typicalMs: 4 * MIN, now: NOW });
    assert.equal(half.stage, 'enhancing');
    assert.equal(half.elapsedMs, 2 * MIN);
    assert.equal(half.etaMs, 2 * MIN);
    assert.ok(half.fraction > 0.4 && half.fraction < 0.6);

    // An over-running job never claims to be finished, and its ETA floors at 0.
    const over = exrProgress(job, { typicalMs: MIN, now: NOW });
    assert.equal(over.fraction, 0.95);
    assert.equal(over.etaMs, 0);

    // No history yet: show the stage honestly, not an invented percentage.
    const fresh = exrProgress(job, { typicalMs: null, now: NOW });
    assert.equal(fresh.fraction, 0.05);
    assert.equal(fresh.etaMs, null);
});

test('a provider-reported percent beats the estimate, whether 0–1 or 0–100', () => {
    const job = { status: 'processing', provider_task_id: 't1', started_at: new Date(NOW - MIN).toISOString() };
    assert.equal(exrProgress({ ...job, result: { progress: 62 } }, { typicalMs: 4 * MIN, now: NOW }).fraction, 0.62);
    assert.equal(exrProgress({ ...job, result: { progress: 0.4 } }, { typicalMs: 4 * MIN, now: NOW }).fraction, 0.4);
});

test('terminal states are absolute', () => {
    assert.deepEqual(exrProgress({ status: 'succeeded' }, { now: NOW }).stage, 'done');
    assert.equal(exrProgress({ status: 'succeeded' }, { now: NOW }).fraction, 1);
    for (const status of ['failed', 'rejected', 'cancelled']) {
        assert.equal(exrProgress({ status }, { now: NOW }).stage, 'failed');
    }
});
