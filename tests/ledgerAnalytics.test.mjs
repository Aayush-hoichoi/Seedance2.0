import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLedgerStatusAnalytics, buildLedgerStatusAnalyticsFromCounts } from '../app/console/ledger/ledgerAnalytics.mjs';

test('ledger analytics calculates exact loaded-row outcomes and excludes active jobs from success rate', () => {
    const analytics = buildLedgerStatusAnalytics([
        { Status: 'succeeded' },
        { Status: 'succeeded' },
        { Status: 'failed' },
        { Status: 'timed_out' },
        { Status: 'queued' },
        { Status: 'running' },
    ]);

    assert.equal(analytics.total, 6);
    assert.equal(analytics.succeeded, 2);
    assert.equal(analytics.failed, 2);
    assert.equal(analytics.active, 2);
    assert.equal(analytics.completed, 4);
    assert.equal(analytics.successRate, 50);
});

test('ledger analytics handles a view with only active jobs', () => {
    const analytics = buildLedgerStatusAnalytics([{ Status: 'queued' }, { Status: 'running' }]);
    assert.equal(analytics.successRate, null);
    assert.deepEqual(analytics.segments.map((segment) => segment.key), ['queued', 'running']);
});

test('ledger analytics keeps an unexpected status in the exact total', () => {
    const analytics = buildLedgerStatusAnalytics([{ Status: 'pending_review' }]);
    assert.equal(analytics.total, 1);
    assert.deepEqual(analytics.segments.map((segment) => segment.key), ['other']);
});

test('ledger analytics uses aggregate status counts for all matching generations', () => {
    const analytics = buildLedgerStatusAnalyticsFromCounts({
        succeeded: 180, failed: 12, timed_out: 3, rejected: 2, cancelled: 1, queued: 1, running: 1,
    }, 200);

    assert.equal(analytics.total, 200);
    assert.equal(analytics.succeeded, 180);
    assert.equal(analytics.failed, 18);
    assert.equal(analytics.active, 2);
    assert.equal(analytics.successRate, 180 / 198 * 100);
});
