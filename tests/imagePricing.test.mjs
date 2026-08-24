import test from 'node:test';
import assert from 'node:assert/strict';
import { imageCost, imageRate } from '../lib/gateway/imagePricing.mjs';

test('imageCost charges the flat per-image rate at 1K/2K', () => {
    assert.equal(imageCost('nano_banana_pro', 'interactive', 1), 0.134);
    assert.equal(imageCost('nano_banana_pro', 'interactive', 1, '2K'), 0.134);
    assert.equal(imageCost('nano_banana_2', 'interactive', 2), 0.078);
    assert.equal(imageCost('seedream_pro', 'interactive', 1), 0.03);
});

test('4K Nano Banana Pro bills the 4K tier (interactive and batch)', () => {
    assert.equal(imageCost('nano_banana_pro', 'interactive', 1, '4K'), 0.24);
    assert.equal(imageCost('nano_banana_pro', 'batch', 2, '4K'), 0.24); // 2 × 0.12
    assert.equal(imageRate('nano_banana_pro', 'interactive', '4K'), 0.24);
    assert.equal(imageRate('nano_banana_pro', 'batch', '4K'), 0.12);
});

test('kinds without a 4K-specific rate fall back to their flat rate', () => {
    assert.equal(imageCost('seedream_pro', 'interactive', 1, '4K'), 0.03);
    assert.equal(imageCost('nano_banana_2', 'interactive', 1, '4K'), 0.039);
});

// GPT Image 2 bills a DIFFERENT rate at every tier (6/10/16 credits =
// $0.03/$0.05/$0.08), which the flat-rate + 4K-override shape above cannot
// express: priced through IMAGE_RATES it would charge the 1K rate for a 2K image.
test('ChatGPT Image 2 bills per resolution tier', () => {
    assert.equal(imageRate('chatgpt_image_2', 'interactive', '1K'), 0.03);
    assert.equal(imageRate('chatgpt_image_2', 'interactive', '2K'), 0.05);
    assert.equal(imageRate('chatgpt_image_2', 'interactive', '4K'), 0.08);
    assert.equal(imageCost('chatgpt_image_2', 'interactive', 2, '2K'), 0.1);
});

// kie renders 1K whenever no explicit ratio/resolution is sent, so 1K is the
// rate we would really pay — not a free generation.
test('ChatGPT Image 2 with no tier requested prices at 1K', () => {
    assert.equal(imageCost('chatgpt_image_2', 'interactive', 1), 0.03);
});

test('unknown kind, unknown mode, or zero count', () => {
    assert.equal(imageCost('nope', 'interactive', 1), null);
    assert.equal(imageCost('nano_banana_pro', 'interactive', 0), null);
    assert.equal(imageCost('seedream_pro', 'batch', 1), 0.03); // no batch rate → interactive fallback
});
