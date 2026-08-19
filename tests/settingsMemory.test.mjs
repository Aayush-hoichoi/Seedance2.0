import test from 'node:test';
import assert from 'node:assert/strict';
import { packSettings, unpackSettings, SETTINGS_VERSION } from '../lib/seedance/settingsMemory.mjs';

// Mirror the real catalog shape without importing the ESM constants.
const DEFAULTS = {
    model: 'mini', ratio: 'adaptive', resolution: '720p', duration: 5,
    generate_audio: true, watermark: false, seed: -1,
    imageRatio: '1:1', imageResolution: '2K', imageStudio: false,
};
const CATALOG = {
    defaults: DEFAULTS,
    modeIds: ['motion_capture', 't2v', 'i2v'],
    modelIds: ['mini', 'pro'],
    ratios: ['adaptive', '16:9', '9:16'],
    resolutions: ['480p', '720p', '1080p', '4k'],
    modelSupports1080p: (id) => id === 'pro',
    modelSupports4k: (id) => id === 'pro',
    imageModelIds: ['nano-banana-2', 'nano-banana-pro', 'cinematic-studio'],
    imageRatios: ['1:1', '16:9', '9:16'],
    imageResolutions: ['1K', '2K', '4K'],
    imageDefaultModelId: 'nano-banana-2',
    imageStudioModelId: 'cinematic-studio',
};

const videoSetup = (over = {}) => ({
    modeId: 'motion_capture',
    mediaType: 'video',
    options: { ...DEFAULTS, model: 'pro', ratio: '9:16', resolution: '1080p', duration: 12, generate_audio: false, watermark: true, seed: 4242, ...over },
});
const roundTrip = (s) => unpackSettings(packSettings(s), CATALOG);

test('mode, model, ratio, resolution, duration and seed all come back as set', () => {
    const out = roundTrip(videoSetup());
    assert.equal(out.modeId, 'motion_capture');
    assert.equal(out.mediaType, 'video');
    assert.deepEqual(out.options, {
        model: 'pro', ratio: '9:16', resolution: '1080p', duration: 12,
        generate_audio: false, watermark: true, seed: 4242,
        imageRatio: '1:1', imageResolution: '2K', imageStudio: false,
    });
});

test('a seed typed into the pill (a string) comes back as the same number', () => {
    // SeedControl writes the raw <input> value, so state holds "1234" — losing
    // it to -1 would silently re-randomise a generation the user pinned.
    assert.equal(roundTrip(videoSetup({ seed: '1234' })).options.seed, 1234);
    assert.equal(roundTrip(videoSetup({ seed: '-1' })).options.seed, -1);
});

test('Auto duration survives (it is -1, not a missing value)', () => {
    assert.equal(roundTrip(videoSetup({ duration: -1 })).options.duration, -1);
});

test('a setting that no longer fits the catalog falls back alone', () => {
    const out = roundTrip(videoSetup({ model: 'retired-model', ratio: '5:1' }));
    assert.equal(out.options.model, DEFAULTS.model);
    assert.equal(out.options.ratio, DEFAULTS.ratio);
    assert.equal(out.options.resolution, '720p'); // 1080p clamped: mini can't do it
    assert.equal(out.options.duration, 12); // untouched
    assert.equal(out.modeId, 'motion_capture');
});

test('a mode the catalog dropped is ignored, leaving the studio default', () => {
    const out = roundTrip({ ...videoSetup(), modeId: 'retired_mode' });
    assert.equal(out.modeId, null);
});

test('image settings keep their own model, ratio and tier', () => {
    const out = roundTrip({ modeId: 't2v', mediaType: 'image', options: { ...DEFAULTS, model: 'nano-banana-pro', imageRatio: '16:9', imageResolution: '4K' } });
    assert.equal(out.mediaType, 'image');
    assert.equal(out.options.model, 'nano-banana-pro');
    assert.equal(out.options.imageRatio, '16:9');
    assert.equal(out.options.imageResolution, '4K');
});

test('Cinematic Studio restores as the studio model, flag and id agreeing', () => {
    const out = roundTrip({ modeId: 't2v', mediaType: 'image', options: { ...DEFAULTS, model: 'nano-banana-2', imageStudio: true } });
    assert.equal(out.options.imageStudio, true);
    assert.equal(out.options.model, 'cinematic-studio');
});

test('the video and image model fields never cross over', () => {
    // Saved in image mode, `model` holds an image id — the video catalog must
    // not be handed it, and vice versa.
    assert.equal(roundTrip({ modeId: 't2v', mediaType: 'image', options: { ...DEFAULTS, model: 'nano-banana-2' } }).options.model, 'nano-banana-2');
    assert.equal(roundTrip({ modeId: 't2v', mediaType: 'video', options: { ...DEFAULTS, model: 'nano-banana-2' } }).options.model, DEFAULTS.model);
});

test('nothing but settings is ever written to storage', () => {
    // The prompt and attached references must not ride along: a reload should
    // never refill a prompt or re-attach a file the user has moved on from.
    const packed = packSettings({
        ...videoSetup(),
        prompt: 'a cat walking',
        mediaByRole: { reference_video: [{ url: 'https://tos/a.mp4' }] },
        imageRefs: [{ b64: 'AAAA' }],
    });
    assert.deepEqual(Object.keys(packed).sort(), ['mediaType', 'modeId', 'options', 'v']);
    assert.doesNotMatch(JSON.stringify(packed), /cat walking|tos\/a\.mp4|AAAA/);
});

test('garbage, an unknown version, or nothing stored restores nothing', () => {
    assert.equal(unpackSettings(null, CATALOG), null);
    assert.equal(unpackSettings('nope', CATALOG), null);
    assert.equal(unpackSettings({ ...packSettings(videoSetup()), v: SETTINGS_VERSION + 1 }, CATALOG), null);
});
