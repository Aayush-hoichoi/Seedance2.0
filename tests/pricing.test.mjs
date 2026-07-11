import test from 'node:test';
import assert from 'node:assert/strict';
import { resolutionTier, unitPrice, costFromTokens, estimateCost } from '../lib/seedance/pricing.mjs';

test('resolutionTier maps 480p/720p to sd, 1080p and 4k to themselves', () => {
    assert.equal(resolutionTier('480p'), 'sd');
    assert.equal(resolutionTier('720p'), 'sd');
    assert.equal(resolutionTier('1080p'), '1080p');
    assert.equal(resolutionTier('4k'), '4k');
});

test('unitPrice picks the right rate per model/tier/video-input', () => {
    assert.equal(unitPrice('full', '720p', false), 7.0);
    assert.equal(unitPrice('full', '720p', true), 4.3);
    assert.equal(unitPrice('full', '4k', true), 2.4);
    assert.equal(unitPrice('fast', '720p', false), 5.6);
    assert.equal(unitPrice('mini', '480p', true), 2.1);
});

test('unitPrice returns null for unsupported combos', () => {
    assert.equal(unitPrice('fast', '4k', false), null); // Fast has no 4k tier
    assert.equal(unitPrice('nope', '720p', false), null);
});

test('costFromTokens = unitPrice/1e6 * tokens, rounded to 4dp', () => {
    assert.equal(costFromTokens('mini', '480p', false, 1_000_000), 3.5);
    assert.equal(costFromTokens('full', '720p', false, 500_000), 3.5);
    assert.equal(costFromTokens('full', '4k', false, 0), 0);
    assert.equal(costFromTokens('nope', '720p', false, 100), null);
});

test('estimateCost scales the 5s example by duration', () => {
    assert.equal(estimateCost({ kind: 'mini', resolution: '480p', duration: 5 }), 0.18);
    assert.equal(estimateCost({ kind: 'mini', resolution: '480p', duration: 10 }), 0.36);
    assert.equal(estimateCost({ kind: 'full', resolution: '720p', duration: 5 }), 0.76);
});

test('estimateCost applies the measured video-input drift (~17% up)', () => {
    assert.equal(estimateCost({ kind: 'mini', resolution: '480p', duration: 5, hasVideoInput: true }), 0.2106);
    const plain = estimateCost({ kind: 'full', resolution: '1080p', duration: 10 });
    const withVideo = estimateCost({ kind: 'full', resolution: '1080p', duration: 10, hasVideoInput: true });
    assert.ok(withVideo > plain, 'video input must raise the estimate');
});
