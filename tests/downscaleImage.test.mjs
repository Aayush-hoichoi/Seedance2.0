import test from 'node:test';
import assert from 'node:assert/strict';

import { fitDims, padDims } from '../lib/seedance/downscaleImage.js';
import { IMAGE_LIMITS, validateImageDimensions } from '../lib/seedance/limits.js';

const { maxDim } = IMAGE_LIMITS; // 6000

test('the reported case 6336×2688 fits under maxDim with aspect preserved', () => {
    const { width, height } = fitDims(6336, 2688, maxDim);
    assert.equal(width, 6000);                    // longest side clamped exactly
    assert.ok(Math.max(width, height) <= maxDim); // no side exceeds the cap
    // aspect ratio held to within a rounding pixel
    assert.ok(Math.abs(width / height - 6336 / 2688) < 0.01);
});

test('already-within-limits images are left unchanged', () => {
    assert.deepEqual(fitDims(1920, 1080, maxDim), { width: 1920, height: 1080 });
});

test('portrait orientation clamps the tall side', () => {
    const { width, height } = fitDims(2688, 6336, maxDim);
    assert.equal(height, 6000);
    assert.ok(Math.max(width, height) <= maxDim);
});

test("Shinjini's 1600×329 WhatsApp banner pads to a legal canvas", () => {
    const { width, height } = padDims(1600, 329);
    assert.equal(width, 1600);           // wide side untouched
    assert.equal(height, 640);           // padded up to width / maxAspect
    assert.equal(validateImageDimensions(width, height), null);
});

test('padDims fixes too-tall, too-small, and leaves legal images alone', () => {
    // Too tall (aspect < 0.4): width pads out.
    assert.equal(validateImageDimensions(...Object.values(padDims(329, 1600))), null);
    // Under minDim on both sides.
    assert.deepEqual(padDims(100, 100), { width: 300, height: 300 });
    // Legal input is a no-op.
    assert.deepEqual(padDims(1920, 1080), { width: 1920, height: 1080 });
});
