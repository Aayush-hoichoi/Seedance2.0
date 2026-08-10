import test from 'node:test';
import assert from 'node:assert/strict';
import { createWithQuotaRecovery, isCapacityQuota } from '../lib/seedance/assetsClient.js';

// createWithQuotaRecovery reacts to a full asset pool by DELETING assets: every
// studio asset older than an hour, and if that frees nothing, everything older
// than five minutes across every studio group. That is the right trade when the
// pool is genuinely full and quite wrong otherwise, so what counts as "full"
// has to be exact.
//
// It used to test /quota/i. BytePlus's per-minute write limit is reported as
// QuotaWriteQPMExceeded, so a burst of parallel uploads — the very thing the
// backoff in callAsset exists to absorb — was read as pool exhaustion. The
// studio deleted its own in-flight references and then reported a full pool
// that, when checked on 2026-08-10, held four objects.

function recorder(behaviour) {
    const calls = [];
    const cleanup = async (opts) => { calls.push(opts); return behaviour.freed ?? 0; };
    return { calls, cleanup };
}

// Fails `failures` times, then succeeds.
function flaky(message, failures) {
    let n = 0;
    return async () => {
        if (n++ < failures) throw new Error(message);
        return 'created';
    };
}

test('a per-minute write throttle is not treated as a full pool', () => {
    assert.equal(isCapacityQuota('QuotaWriteQPMExceeded'), false);
    assert.equal(isCapacityQuota('QuotaWriteQPSExceeded'), false, 'per-second too');
});

test('genuine capacity exhaustion still counts as a full pool', () => {
    assert.equal(isCapacityQuota('Asset quota exceeded: the shared pool is full.'), true);
});

test('a throttle error deletes nothing and propagates unchanged', async () => {
    const { calls, cleanup } = recorder({ freed: 0 });
    await assert.rejects(
        () => createWithQuotaRecovery(flaky('QuotaWriteQPMExceeded', 99), cleanup),
        /QuotaWriteQPMExceeded/,
        'the caller must see the real throttle error, not a pool story',
    );
    assert.deepEqual(calls, [], 'a rate limit must never delete a single asset');
});

test('a non-quota error deletes nothing and propagates unchanged', async () => {
    const { calls, cleanup } = recorder({ freed: 0 });
    await assert.rejects(
        () => createWithQuotaRecovery(flaky('The source media failed verification', 99), cleanup),
        /failed verification/,
    );
    assert.deepEqual(calls, []);
});

test('real capacity exhaustion still sweeps and retries', async () => {
    const { calls, cleanup } = recorder({ freed: 3 });
    const result = await createWithQuotaRecovery(flaky('Asset quota exceeded: pool is full', 1), cleanup);
    assert.equal(result, 'created', 'the second attempt should succeed after the sweep');
    assert.deepEqual(calls, [{ maxAgeHours: 1 }], 'one hour first; it freed rows, so no aggressive pass');
});

test('when the hourly sweep frees nothing it escalates to the five-minute pass', async () => {
    const { calls, cleanup } = recorder({ freed: 0 });
    await assert.rejects(
        () => createWithQuotaRecovery(flaky('Asset quota exceeded: pool is full', 99), cleanup),
        /asset pool is still full/,
        'after both sweeps fail the user gets the manual-cleanup message',
    );
    assert.deepEqual(calls, [{ maxAgeHours: 1 }, { maxAgeHours: 5 / 60 }]);
});

test('a successful create never sweeps', async () => {
    const { calls, cleanup } = recorder({ freed: 0 });
    assert.equal(await createWithQuotaRecovery(async () => 'created', cleanup), 'created');
    assert.deepEqual(calls, []);
});
