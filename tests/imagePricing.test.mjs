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

// --- the env overrides ---------------------------------------------------------
//
// This module is read by BOTH the gateway (which reserves budget) and the prompt
// bar (a client component, which quotes the user a price). Next.js only inlines
// NEXT_PUBLIC_* into the browser bundle, so an unprefixed override moved one side
// and not the other: the user was quoted the built-in default and charged the
// override. The rates are re-read at import, so each case loads a fresh copy.

const freshRates = async (env, tag) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
        return await import(`../lib/gateway/imagePricing.mjs?case=${tag}`);
    } finally {
        for (const k of Object.keys(env)) delete process.env[k];
        Object.assign(process.env, saved);
    }
};

test('a NEXT_PUBLIC_ override replaces the built-in rate', async () => {
    const { imageRate: rate } = await freshRates({ NEXT_PUBLIC_PRICE_SEEDREAM_PRO: '0.09' }, 'override');
    assert.equal(rate('seedream_pro', 'interactive'), 0.09);
});

test('an unprefixed override is IGNORED rather than splitting the two sides', async () => {
    // It cannot reach the browser, so honouring it server-side would charge a
    // rate the bar never showed. Ignoring it keeps both sides on the default —
    // wrong for the operator, but at least identical for the user. The module
    // warns on load so the rename does not go unnoticed.
    const { imageRate: rate } = await freshRates({ PRICE_SEEDREAM_PRO: '0.09' }, 'legacy');
    assert.equal(rate('seedream_pro', 'interactive'), 0.03);
});

test('a blank override falls back to the default instead of pricing the model free', async () => {
    // Number('') is 0 — a present-but-empty env var used to make the model cost
    // nothing, which reserves nothing and takes it outside budget enforcement.
    const { imageRate: rate } = await freshRates({ NEXT_PUBLIC_PRICE_NANO_BANANA_PRO: '' }, 'blank');
    assert.equal(rate('nano_banana_pro', 'interactive'), 0.134);
});

test('a non-numeric override falls back rather than poisoning the rate with NaN', async () => {
    const { imageRate: rate } = await freshRates({ NEXT_PUBLIC_PRICE_CHATGPT_IMAGE_2_2K: 'cheap' }, 'nan');
    assert.equal(rate('chatgpt_image_2', 'interactive', '2K'), 0.05);
});
