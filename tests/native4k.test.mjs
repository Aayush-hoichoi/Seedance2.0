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

test('studio preserves native 4K for Seedance 2.5', () => {
    assert.equal(twoFive.supports4k, true);
    const payload = buildPayload({
        options: { model: twoFive.id, resolution: '4k', ratio: '16:9', duration: 8, generate_audio: true, watermark: false },
        prompt: 'A cinematic mountain landscape',
        mediaItems: [],
    });
    assert.equal(payload.model, twoFive.id);
    assert.equal(payload.resolution, '4k');
});
