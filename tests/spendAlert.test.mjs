import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketFor, spendAlertText } from '../lib/gateway/spendAlerts.mjs';

test('bucketFor: floors cumulative spend into $step milestones', () => {
    assert.equal(bucketFor(0, 500), 0);
    assert.equal(bucketFor(499.99, 500), 0);
    assert.equal(bucketFor(500, 500), 1);
    assert.equal(bucketFor(1250, 500), 2);
    assert.equal(bucketFor(11000, 500), 22);
});

test('bucketFor: guards bad input', () => {
    assert.equal(bucketFor(undefined, 500), 0);
    assert.equal(bucketFor(1000, 0), 0);      // step 0 → no bucketing, never fires
    assert.equal(bucketFor('750', 500), 1);   // numeric-coercible string
});

test('a crossing only fires once: same bucket → no advance', () => {
    // The dedupe is "new bucket > stored bucket"; equal buckets must not re-fire.
    const a = bucketFor(760, 500);
    const b = bucketFor(999, 500);
    assert.equal(a, b); // both in milestone 1 → the second settle sends nothing
});

test('spendAlertText: names the crossed threshold and the running total', () => {
    const msg = spendAlertText(22, 11040, 500);
    assert.match(msg, /\$11,000/); // 22 * 500
    assert.match(msg, /\$11,040/); // rounded total
    assert.match(msg, /Burning money/);
});
