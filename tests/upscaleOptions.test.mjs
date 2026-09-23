import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpscaleRequest, estimateUpscaleCost, estimateUpscaleMinutes, sourceTooLarge, containerFor, targetBitrateMbps, proTier, isUpscaleInputName } from '../lib/byteplus/upscaleOptions.mjs';

test('defaults build a standard 1080p request', () => {
    assert.deepEqual(buildUpscaleRequest({}).body, {
        tool_version: 'standard', scene: 'aigc', enhance_style: 'hd', resolution: '1080p', bitrate_level: 'medium',
    });
});

test('standard never sends pro-only codec fields', () => {
    const { body } = buildUpscaleRequest({ codec: 'ffv1', bitDepth: 16 });
    assert.equal(body.codec, undefined);
    assert.equal(body.bit_depth, undefined);
});

test('resolution modes are mutually exclusive', () => {
    const lim = buildUpscaleRequest({ resolutionMode: 'limit', shortSide: 720 }).body;
    assert.equal(lim.resolution_limit, 720);
    assert.equal(lim.resolution, undefined);
    const src = buildUpscaleRequest({ resolutionMode: 'source' }).body;
    assert.equal(src.resolution, undefined);
    assert.equal(src.resolution_limit, undefined);
    assert.throws(() => buildUpscaleRequest({ resolutionMode: 'limit', shortSide: 100 }), /128 to 4320/);
});

test('fps is sent only when custom, and range-checked', () => {
    assert.equal(buildUpscaleRequest({}).body.fps, undefined);
    assert.equal(buildUpscaleRequest({ fpsMode: 'custom', fps: 60 }).body.fps, 60);
    assert.throws(() => buildUpscaleRequest({ fpsMode: 'custom', fps: 121 }), /15–120/);
    assert.equal(buildUpscaleRequest({ fpsMode: 'custom', fps: 23.976 }).body.fps, 23.976);
    assert.throws(() => buildUpscaleRequest({ fpsMode: 'custom', fps: 23.9761 }), /3 decimals/);
});

test('exact kbps replaces the level', () => {
    const { body } = buildUpscaleRequest({ bitrateMode: 'kbps', kbps: 8000 });
    assert.equal(body.bitrate, 8000);
    assert.equal(body.bitrate_level, undefined);
    assert.throws(() => buildUpscaleRequest({ bitrateMode: 'kbps', kbps: 5 }), /10 to 150000/);
});

test('professional validates codec/bit-depth pairs and drops bitrate for lossless', () => {
    const pro = { version: 'professional' };
    assert.throws(() => buildUpscaleRequest({ ...pro, codec: 'h264', bitDepth: 10 }), /8-bit/);
    const prores = buildUpscaleRequest({ ...pro, codec: 'prores', bitDepth: 10 }).body;
    assert.equal(prores.codec, 'prores');
    assert.equal(prores.bitrate_level, undefined);
    assert.equal(containerFor({ ...pro, codec: 'prores' }), 'mov');
    assert.throws(() => buildUpscaleRequest({ ...pro, codec: 'ffv1', bitDepth: 16 }, { sourceSeconds: 41 }), /40s/);
    assert.ok(buildUpscaleRequest({ ...pro, codec: 'ffv1', bitDepth: 16 }, { sourceSeconds: 40 }));
});

test('rejects unknown enum values', () => {
    assert.throws(() => buildUpscaleRequest({ version: 'fast' }), /version/);
    assert.throws(() => buildUpscaleRequest({ scene: 'x' }), /scene/);
});

test('cost matches the BytePlus worked examples', () => {
    // 1 min, 1080p, 30fps: standard $0.4132, professional $4.132
    assert.ok(Math.abs(estimateUpscaleCost({}, { seconds: 60 }) - 0.4132) < 1e-9);
    assert.ok(Math.abs(estimateUpscaleCost({ version: 'professional' }, { seconds: 60 }) - 4.132) < 1e-9);
    // 60fps doubles
    assert.ok(Math.abs(estimateUpscaleCost({ fpsMode: 'custom', fps: 60 }, { seconds: 60 }) - 0.8264) < 1e-9);
    assert.equal(estimateUpscaleCost({}, {}), null);
});

test('wait estimate and input size guard', () => {
    assert.equal(estimateUpscaleMinutes({}, 60), 8);
    assert.equal(estimateUpscaleMinutes({ version: 'professional', resolution: '4k' }, 60), 60);
    assert.equal(sourceTooLarge(1920, 1080), false);
    assert.equal(sourceTooLarge(3840, 2160), true);
});

test('reference tables: bitrate targets, pro tier, input formats', () => {
    assert.equal(targetBitrateMbps({ resolutionMode: 'preset', resolution: '1080p', fpsMode: 'custom', fps: 60, bitrateLevel: 'high' }), 18);
    assert.equal(targetBitrateMbps({ resolutionMode: 'preset', resolution: '6k', fpsMode: 'custom', fps: 30, bitrateLevel: 'low' }), null);
    assert.equal(targetBitrateMbps({ resolutionMode: 'source', fpsMode: 'custom', fps: 30, bitrateLevel: 'low' }), null);
    assert.equal(proTier({ version: 'standard' }), null);
    assert.match(proTier({ version: 'professional', resolutionMode: 'preset', resolution: '4k', scene: 'aigc' }), /Ultimate/);
    assert.match(proTier({ version: 'professional', resolutionMode: 'preset', resolution: '2k', scene: 'aigc' }), /Premium/);
    assert.match(proTier({ version: 'professional', scene: 'old_film' }), /restoration/);
    assert.ok(isUpscaleInputName('clip.MKV'));
    assert.ok(!isUpscaleInputName('clip.webm'));
});
