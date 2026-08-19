import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, durationsFor, durationMaxFor, durationValidFor, DURATIONS } from '../lib/seedance/constants.js';
import { sanitizeOptions } from '../lib/seedance/options.mjs';

// The duration range was ONE global [4,15], derived from Seedance 2.0 and
// applied to every model — the same true-by-analogy mistake as the 1080p
// ceiling, pointing the other way: instead of promising a tier the provider
// rejects, it HID half of what 2.5 can do. Live-probed per tier 2026-08-19:
//
//   2.5       30 accepted · 31 "not valid for model dreamina-seedance-2-5 in t2v"
//   2.0       30 rejected
//   2.0 Fast  16 rejected
//   2.0 Mini  16 rejected
//   1.5 Pro   16 rejected

const id = (kind) => MODELS.find((m) => m.kind === kind).id;

test('2.5 reaches 30s and stops there — the probed boundary, not a guess', () => {
    const m = id('full_2_5');
    assert.equal(durationMaxFor(m), 30);
    assert.equal(durationValidFor(m, 30), true);
    assert.equal(durationValidFor(m, 31), false, '31 is rejected by the provider');
});

test('every other tier keeps 15 — the ceiling is per model, not global', () => {
    for (const kind of ['full', 'fast', 'mini', 'pro_1_5']) {
        assert.equal(durationMaxFor(id(kind)), 15, `${kind} must not inherit 2.5's ceiling`);
        assert.equal(durationValidFor(id(kind), 30), false, `${kind} rejects 30 at the provider`);
        assert.equal(durationValidFor(id(kind), 15), true);
    }
});

test('the floor and Auto hold on every tier', () => {
    for (const m of MODELS) {
        assert.equal(durationValidFor(m.id, -1), true, 'Auto is valid everywhere — and is what an edit requires');
        assert.equal(durationValidFor(m.id, 3), false, 'below the 4s floor');
        assert.equal(durationValidFor(m.id, 4.5), false, 'seconds are integers');
    }
});

test('an unknown model falls back to the conservative range, never 2.5’s', () => {
    assert.equal(durationMaxFor('some-future-model'), 15);
    assert.equal(durationValidFor('some-future-model', 30), false,
        'a new tier must prove 30s against the API before offering it');
});

test('the picker offers exactly the stops each model can actually render', () => {
    assert.deepEqual(durationsFor(id('full_2_5')), [-1, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30]);
    assert.deepEqual(durationsFor(id('full')), [-1, 4, 5, 6, 8, 10, 12, 15]);
    assert.ok(durationsFor(id('full_2_5')).every((d) => durationValidFor(id('full_2_5'), d)),
        'never offer a stop the validator would reject');
});

test('the legacy DURATIONS export stays the conservative range', () => {
    assert.deepEqual(DURATIONS, [-1, 4, 5, 6, 8, 10, 12, 15],
        'callers that predate the split must not silently gain 2.5-only tiers');
});

// --- the server-side clamp -----------------------------------------------------

const opts = (model, duration) => sanitizeOptions(
    { model, duration, ratio: '16:9', resolution: '720p' },
    {
        defaults: { model, duration: 5, ratio: '16:9', resolution: '720p', generate_audio: false, watermark: false, seed: null },
        modelIds: MODELS.map((m) => m.id), ratios: ['16:9'], resolutions: ['480p', '720p', '1080p', '4k'],
        modelSupports1080p: () => true, modelSupports4k: () => false,
        modelDurationMax: (m) => durationMaxFor(m),
    },
);

test('the clamp lets 2.5 through at 30 and rejects it for 2.0', () => {
    assert.equal(opts(id('full_2_5'), 30).duration, 30);
    assert.equal(opts(id('full'), 30).duration, 5, 'falls back to the default rather than sending an invalid value');
});

test('omitting the ceiling keeps the old conservative behaviour', () => {
    // A caller that does not pass modelDurationMax must not accidentally widen.
    const out = sanitizeOptions(
        { model: id('full_2_5'), duration: 30, ratio: '16:9', resolution: '720p' },
        {
            defaults: { model: id('full_2_5'), duration: 5, ratio: '16:9', resolution: '720p', generate_audio: false, watermark: false, seed: null },
            modelIds: MODELS.map((m) => m.id), ratios: ['16:9'], resolutions: ['720p'],
            modelSupports1080p: () => true, modelSupports4k: () => false,
        },
    );
    assert.equal(out.duration, 5, 'no ceiling supplied → the 15s default range applies');
});
