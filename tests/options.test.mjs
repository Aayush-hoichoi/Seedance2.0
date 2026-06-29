import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeOptions } from '../lib/seedance/options.mjs';

// Mirror the real catalog shape without importing the ESM constants.
const DEFAULTS = { model: 'pro', ratio: 'adaptive', resolution: '720p', duration: 5, generate_audio: true, watermark: false, seed: -1 };
const CATALOG = {
    defaults: DEFAULTS,
    modelIds: ['pro', 'fast'],
    ratios: ['adaptive', '16:9', '9:16', '1:1'],
    resolutions: ['480p', '720p', '1080p', '4k'],
    modelSupports1080p: (id) => id === 'pro',
};

test('restores a full valid snapshot verbatim', () => {
    const snap = { model: 'pro', ratio: '9:16', resolution: '1080p', duration: 10, generate_audio: false, watermark: true, seed: 42 };
    assert.deepEqual(sanitizeOptions(snap, CATALOG), snap);
});

test('clamps 1080p to 720p when the model does not support it', () => {
    const out = sanitizeOptions({ model: 'fast', resolution: '1080p' }, CATALOG);
    assert.equal(out.resolution, '720p');
    assert.equal(out.model, 'fast');
});

test('passes 4k through unchanged (4k is gated in the UI, not clamped here)', () => {
    // 4k is offered only on supporting models via the dropdown filter; the
    // sanitizer just accepts it as a valid resolution and never steps it down.
    assert.equal(sanitizeOptions({ model: 'pro', resolution: '4k' }, CATALOG).resolution, '4k');
    assert.equal(sanitizeOptions({ model: 'fast', resolution: '4k' }, CATALOG).resolution, '4k');
});

test('fills missing fields from defaults (partial server-card snapshot)', () => {
    const out = sanitizeOptions({ resolution: '480p', duration: 8, seed: 7 }, CATALOG);
    assert.deepEqual(out, { model: 'pro', ratio: 'adaptive', resolution: '480p', duration: 8, generate_audio: true, watermark: false, seed: 7 });
});

test('rejects out-of-range / wrong-type values back to defaults', () => {
    const out = sanitizeOptions({ model: 'ghost', ratio: '5:1', resolution: '8k', duration: 99, generate_audio: 'yes', watermark: 1, seed: 'x' }, CATALOG);
    assert.deepEqual(out, DEFAULTS);
});

test('keeps duration -1 (auto) and the valid boundaries', () => {
    assert.equal(sanitizeOptions({ duration: -1 }, CATALOG).duration, -1);
    assert.equal(sanitizeOptions({ duration: 4 }, CATALOG).duration, 4);
    assert.equal(sanitizeOptions({ duration: 15 }, CATALOG).duration, 15);
    assert.equal(sanitizeOptions({ duration: 3 }, CATALOG).duration, 5); // below min → default
});

test('absent / non-object snapshot yields defaults', () => {
    assert.deepEqual(sanitizeOptions(null, CATALOG), DEFAULTS);
    assert.deepEqual(sanitizeOptions(undefined, CATALOG), DEFAULTS);
    assert.deepEqual(sanitizeOptions('nope', CATALOG), DEFAULTS);
});
