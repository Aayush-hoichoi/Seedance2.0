// Two ceilings bound a generation, and only one of them used to be enforced.
//
//   1. the GRANT cap  — how much of a model this user may use
//   2. the MODEL ladder — how much of the model exists at all
//
// resolutionWithinTier() answers (1). Nothing answered (2), so a request could
// clear every check in this app and be refused by the provider — after it had
// been priced, quota-reserved and submitted. That is not hypothetical: on
// 2026-08-13, five Seedance 2.5 requests at 1080p failed that way against live
// grants that permitted 1080p on a model that tops out at 720p.
//
// The invariant these tests pin: a user may generate at their granted tier and
// every tier below it, and never above — where "above" means above EITHER
// ceiling, whichever is lower.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, RESOLUTIONS, resolutionWithinTier, supportedResolutionsFor } from '../lib/seedance/constants.js';

const ladderFor = (modelId) => supportedResolutionsFor(modelId) ?? [];

// Mirrors the guard in lib/gateway/videoCreate.mjs.
function withinModelCeiling(modelId, resolution) {
    const ladder = ladderFor(modelId);
    if (!ladder.length || !resolution) return true;
    return ladder.some((tier) => tier.toLowerCase() === String(resolution).toLowerCase());
}

// The full decision: both ceilings, as the gateway applies them.
function allowed({ modelId, resolution, grantCap }) {
    return resolutionWithinTier(resolution, grantCap, RESOLUTIONS)
        && withinModelCeiling(modelId, resolution);
}

test('a grant admits its own tier and every tier below it', () => {
    const full = MODELS.find((m) => m.kind === 'full').id;
    for (const tier of ['480p', '720p', '1080p']) {
        assert.equal(allowed({ modelId: full, resolution: tier, grantCap: '1080p' }), true,
            `${tier} must be allowed under a 1080p grant`);
    }
});

test('a grant never admits a tier above it', () => {
    const full = MODELS.find((m) => m.kind === 'full').id;
    assert.equal(allowed({ modelId: full, resolution: '4k', grantCap: '1080p' }), false);
    assert.equal(allowed({ modelId: full, resolution: '1080p', grantCap: '720p' }), false);
});

// --- the ceiling that was missing --------------------------------------------

test('a grant above the model ceiling cannot reach past the model', () => {
    // Still the live Seedance 2.5 case, one tier up: its 1080p refusal was
    // ACCOUNT-scoped and lifted on 2026-08-18, but 4k is a MODEL limit and does
    // not move — so 4k is what a grant must not be able to reach past.
    // (Pinning this to 1080p tied the invariant to an account setting; when that
    // setting changed the test failed while the rule it guards was untouched.)
    const twoFive = MODELS.find((m) => m.kind === 'full_2_5').id;
    assert.equal(allowed({ modelId: twoFive, resolution: '4k', grantCap: '4k' }), false,
        'the model ceiling must win over a stale grant');
    assert.equal(allowed({ modelId: twoFive, resolution: '1080p', grantCap: '4k' }), true,
        'and everything the model does have stays available');
});

test('an UNCAPPED grant is still bounded by the model', () => {
    // max_resolution NULL means "no cap" to resolutionWithinTier — it returns
    // true for every tier, so before the model ceiling existed such a grant was
    // bounded by nothing. Live example: a budget approval left an uncapped
    // allow on a premium model.
    const mini = MODELS.find((m) => m.kind === 'mini').id;
    assert.equal(resolutionWithinTier('4k', null, RESOLUTIONS), true, 'guards the premise');
    assert.equal(allowed({ modelId: mini, resolution: '4k', grantCap: null }), false);
    assert.equal(allowed({ modelId: mini, resolution: '720p', grantCap: null }), true);
});

test('the lower of the two ceilings always wins', () => {
    const full = MODELS.find((m) => m.kind === 'full').id;      // 480p…4k
    const fast = MODELS.find((m) => m.kind === 'fast').id;      // 480p…720p
    // Model is generous, grant is tight → grant wins.
    assert.equal(allowed({ modelId: full, resolution: '4k', grantCap: '720p' }), false);
    // Grant is generous, model is tight → model wins.
    assert.equal(allowed({ modelId: fast, resolution: '1080p', grantCap: '4k' }), false);
});

test('every model ladder is contiguous from 480p and never empty', () => {
    // A ladder with a hole would make "and every tier below" false somewhere.
    for (const model of MODELS) {
        const ladder = ladderFor(model.id);
        assert.ok(ladder.length, `${model.name} must publish a ladder`);
        const expected = RESOLUTIONS.slice(0, ladder.length);
        assert.deepEqual(ladder, expected, `${model.name} ladder must be a prefix of the global ladder`);
    }
});

test('case does not open a hole in either ceiling', () => {
    const twoFive = MODELS.find((m) => m.kind === 'full_2_5').id;
    assert.equal(allowed({ modelId: twoFive, resolution: '4K', grantCap: '4k' }), false);
    assert.equal(allowed({ modelId: twoFive, resolution: '1080P', grantCap: '4k' }), true);
    // The grant side too, not just the model side.
    const full = MODELS.find((m) => m.kind === 'full').id;
    assert.equal(allowed({ modelId: full, resolution: '4K', grantCap: '1080P' }), false);
});
