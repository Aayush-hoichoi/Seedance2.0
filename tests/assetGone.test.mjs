import test from 'node:test';
import assert from 'node:assert/strict';
import { isAssetGone, isCapacityQuota } from '../lib/seedance/assetsClient.js';

// This predicate decides whether a restored draft DROPS one of the user's
// attached references. Wrong in one direction leaves a dead ref that fails the
// generation; wrong in the other silently deletes an attachment because the
// network blipped. The second is worse, so proof of death is required.

test('a genuinely missing asset is gone', () => {
    for (const m of [
        'The specified asset 12345 is not found',
        'GetAsset failed (404): asset not found',
        'Asset does not exist.',
        'no such asset',
        'This asset was deleted.',
    ]) assert.equal(isAssetGone(m), true, m);
});

test('a transient failure is NOT proof of death — the ref must survive it', () => {
    for (const m of [
        'GetAsset failed (429): QuotaWriteQPMExceeded',
        'Throttling: too many requests',
        'GetAsset failed (500): internal error',
        'Failed to fetch',
        'network timeout',
        '',
    ]) assert.equal(isAssetGone(m), false, m);
});

test('it does not overlap with the capacity-quota check beside it', () => {
    // A full pool is not a missing asset; sweeping and dropping are different
    // remedies and must never be triggered by the same message.
    const poolFull = 'CreateAsset failed: asset quota exceeded';
    assert.equal(isCapacityQuota(poolFull), true);
    assert.equal(isAssetGone(poolFull), false);
});

test('a missing default argument does not throw', () => {
    assert.equal(isAssetGone(), false);
});
