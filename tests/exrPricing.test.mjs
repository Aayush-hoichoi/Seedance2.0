import test from 'node:test';
import assert from 'node:assert/strict';
import {
    EXR_DEFAULT_OPTIONS,
    estimateExrCost,
    normalizeExrOptions,
    pricePerExrMinute,
} from '../lib/byteplus/exrPricing.mjs';

test('uses the Pro 4K 24 FPS reference price', () => {
    assert.equal(pricePerExrMinute(EXR_DEFAULT_OPTIONS), 16.5288);
    assert.equal(estimateExrCost(EXR_DEFAULT_OPTIONS, 60), 16.5288);
});

test('calculates the exact total from video length', () => {
    assert.equal(estimateExrCost(EXR_DEFAULT_OPTIONS, 5), 1.3774);
    assert.equal(estimateExrCost({ tier: 'pro', resolution: '4k', fps: 60 }, 5), 2.7548);
});

test('uses the correct FPS price band', () => {
    assert.equal(pricePerExrMinute({ tier: 'pro', resolution: '4k', fps: 30 }), 16.5288);
    assert.equal(pricePerExrMinute({ tier: 'pro', resolution: '4k', fps: 60 }), 33.0576);
    assert.equal(pricePerExrMinute({ tier: 'pro', resolution: '4k', fps: 120 }), 66.1152);
});

test('normalizes valid choices and keeps EXR at 16-bit', () => {
    assert.deepEqual(normalizeExrOptions({ tier: 'standard', resolution: '2K', fps: '60' }), {
        tier: 'standard', resolution: '2k', fps: 60, bitDepth: 16, outputFormat: 'EXR',
    });
});

test('rejects unsupported server choices', () => {
    assert.throws(() => normalizeExrOptions({ bitDepth: 32 }, { strict: true }), /only 16-bit is supported/);
    assert.throws(() => normalizeExrOptions({ fps: 25 }, { strict: true }), /Invalid EXR frame rate/);
});
