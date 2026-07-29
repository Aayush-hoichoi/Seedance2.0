// Quality-tier ladder logic: a grant at one tier includes every lower tier,
// never a higher one — enforced via resolutionWithinTier at the gateway submit
// paths and surfaced through effectiveAccess.maxResolution.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    RESOLUTIONS, IMAGE_RESOLUTIONS, MODELS, resolutionWithinTier, supportedResolutionsFor,
} from '../lib/seedance/constants.js';
import { effectiveAccess } from '../lib/gateway/access.mjs';

test('video ladder: cap includes lower tiers, excludes higher', () => {
    assert.equal(resolutionWithinTier('720p', '1080p', RESOLUTIONS), true);
    assert.equal(resolutionWithinTier('1080p', '1080p', RESOLUTIONS), true);
    assert.equal(resolutionWithinTier('4k', '1080p', RESOLUTIONS), false);
    assert.equal(resolutionWithinTier('480p', '4k', RESOLUTIONS), true);
});

test('image ladder: 4K grant covers 2K/1K; 2K grant blocks 4K', () => {
    assert.equal(resolutionWithinTier('1K', '4K', IMAGE_RESOLUTIONS), true);
    assert.equal(resolutionWithinTier('2K', '4K', IMAGE_RESOLUTIONS), true);
    assert.equal(resolutionWithinTier('4K', '2K', IMAGE_RESOLUTIONS), false);
});

test('null cap = unlimited; unknown tokens never block', () => {
    assert.equal(resolutionWithinTier('4k', null, RESOLUTIONS), true);
    assert.equal(resolutionWithinTier(undefined, '2K', IMAGE_RESOLUTIONS), true); // no size sent
    assert.equal(resolutionWithinTier('8k', '1080p', RESOLUTIONS), true); // shape-validated elsewhere
    assert.equal(resolutionWithinTier('720p', 'weird', RESOLUTIONS), true);
});

test('case-insensitive across video/image token styles', () => {
    assert.equal(resolutionWithinTier('4K', '1080p', RESOLUTIONS), false);
    assert.equal(resolutionWithinTier('2k', '4K', IMAGE_RESOLUTIONS), true);
});

test('supportedResolutionsFor follows model capability', () => {
    const full = MODELS.find((m) => m.kind === 'full');
    const fast = MODELS.find((m) => m.kind === 'fast');
    assert.deepEqual(supportedResolutionsFor(full.id), ['480p', '720p', '1080p', '4k']);
    assert.deepEqual(supportedResolutionsFor(fast.id), ['480p', '720p']);
    assert.deepEqual(supportedResolutionsFor('seedream-5.0-pro'), ['2K', '4K']);
    assert.deepEqual(supportedResolutionsFor('nano-banana-pro'), ['1K', '2K', '4K']);
    assert.equal(supportedResolutionsFor('no-such-model'), null);
});

test('supportedResolutionsFor accepts stable gateway aliases used by the console', () => {
    assert.deepEqual(supportedResolutionsFor('seedance-2.0'), ['480p', '720p', '1080p', '4k']);
    assert.deepEqual(supportedResolutionsFor('seedance-2.0-fast'), ['480p', '720p']);
    assert.deepEqual(supportedResolutionsFor('seedance-2.0-mini'), ['480p', '720p']);
    assert.deepEqual(supportedResolutionsFor('seedance-1.5-pro'), ['480p', '720p', '1080p']);
});

test('effectiveAccess carries the allow-override cap; grants/defaults are uncapped', () => {
    const now = new Date('2026-07-19T00:00:00Z');
    const capped = effectiveAccess({
        modelId: 'm1', now,
        overrides: [{ model_id: 'm1', effect: 'allow', max_resolution: '2K', revoked_at: null }],
    });
    assert.equal(capped.allowed, true);
    assert.equal(capped.maxResolution, '2K');

    const viaGrant = effectiveAccess({
        modelId: 'm1', now,
        grants: [{ model_id: 'm1', revoked_at: null }],
    });
    assert.equal(viaGrant.allowed, true);
    assert.equal(viaGrant.maxResolution, null);

    const viaDefault = effectiveAccess({ modelId: 'm1', now, defaultModelIds: ['m1'] });
    assert.equal(viaDefault.maxResolution, null);

    // An uncapped allow override reports null (no cap), and deny still wins.
    const uncapped = effectiveAccess({
        modelId: 'm1', now,
        overrides: [{ model_id: 'm1', effect: 'allow', revoked_at: null }],
    });
    assert.equal(uncapped.maxResolution, null);
    const denied = effectiveAccess({
        modelId: 'm1', now,
        overrides: [
            { model_id: 'm1', effect: 'deny', revoked_at: null },
            { model_id: 'm1', effect: 'allow', max_resolution: '4K', revoked_at: null },
        ],
    });
    assert.equal(denied.allowed, false);
});
