import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, supportedResolutionsFor } from '../lib/seedance/constants.js';
import { buildPayload } from '../lib/seedance/client.js';

const standard = MODELS.find((model) => model.kind === 'full');
const twoFive = MODELS.find((model) => model.kind === 'full_2_5');

test('standard Seedance 2.0 advertises native 4K', () => {
    assert.equal(standard.supports4k, true);
    assert.ok(supportedResolutionsFor(standard.id).includes('4k'));
});

test('studio payload preserves native 4K for standard Seedance 2.0', () => {
    const payload = buildPayload({
        options: { model: standard.id, resolution: '4k', ratio: '16:9', duration: 5, generate_audio: true, watermark: false },
        prompt: 'A cinematic mountain landscape',
        mediaItems: [],
    });
    assert.equal(payload.model, standard.id);
    assert.equal(payload.resolution, '4k');
});

// Live-probed 2026-09-22: ModelArk rejects 4k on the 2.5 endpoint ("not
// supported for this account and model"). See the ledger in constants.js.
test('Seedance 2.5 does not advertise 4K until the account is enabled for it', () => {
    assert.equal(twoFive.supports4k, false);
    assert.ok(!supportedResolutionsFor(twoFive.id).includes('4k'));
    assert.ok(supportedResolutionsFor(twoFive.id).includes('1080p'));
    assert.throws(() => buildPayload({
        options: { model: twoFive.id, resolution: '4k', ratio: '16:9', duration: 8, generate_audio: true, watermark: false },
        prompt: 'A cinematic mountain landscape',
        mediaItems: [],
    }), /does not support 4k/);
});
