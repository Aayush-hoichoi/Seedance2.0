// Ratio × resolution coupling. Most image models take the two independently;
// kie.ai's GPT Image 2 does not, and the rejected combinations fail AT TASK
// CREATION — after the job has been priced and the budget reserved. The rules
// come from the model's own API reference (docs.kie.ai, read 2026-08-22), so
// they get a test rather than a comment: the picker, the submit boundary and the
// provider adapter all read these two functions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { imageResolutionsFor, clampImageResolution, IMAGE_MODELS, IMAGE_RATIOS } from '../lib/seedance/constants.js';

test('models without the coupling return their full ladder whatever the ratio', () => {
    assert.deepEqual(imageResolutionsFor('nano-banana-pro', '1:1'), ['1K', '2K', '4K']);
    assert.deepEqual(imageResolutionsFor('nano-banana-2', '1:1'), ['1K', '2K']);
    assert.deepEqual(imageResolutionsFor('seedream-5.0-pro', '1:1'), ['2K', '4K']);
});

test('unknown model has no ladder', () => {
    assert.equal(imageResolutionsFor('nope', '1:1'), null);
});

// Live-probed 2026-08-22 (see the comment block in constants.js). kie's API
// reference claims 1:1 tops out at 2K and that an unspecified ratio is 1K-only;
// both DELIVERED 2880×2880 in a real task. Encoding the docs would have blocked
// 4K at the studio's default ratio — so these two assertions guard against
// "fixing" the code back to what the documentation says.
test('GPT Image 2 renders 4K at 1:1, whatever the docs claim', () => {
    assert.deepEqual(imageResolutionsFor('chatgpt-image-2', '1:1'), ['1K', '2K', '4K']);
    assert.equal(clampImageResolution('chatgpt-image-2', '1:1', '4K'), '4K');
});

test('GPT Image 2 renders 4K with no explicit ratio', () => {
    assert.deepEqual(imageResolutionsFor('chatgpt-image-2', null), ['1K', '2K', '4K']);
    assert.equal(clampImageResolution('chatgpt-image-2', null, '4K'), '4K');
});

// The one restriction that survived probing: 5:4 @ 4K is a 422 at create,
// 5:4 @ 1K delivered 1402×1122.
test('GPT Image 2 caps 5:4 and 4:5 at 1K', () => {
    for (const ratio of ['5:4', '4:5']) {
        assert.deepEqual(imageResolutionsFor('chatgpt-image-2', ratio), ['1K'], `${ratio} supports 1K only`);
        assert.equal(clampImageResolution('chatgpt-image-2', ratio, '4K'), '1K');
    }
});

// THE PICKER CAN NEVER PRODUCE A COMBINATION THE MODEL REFUSES.
//
// The studio offers a global ratio list (IMAGE_RATIOS) crossed with each model's
// own tiers, and today none of those pairs is restricted — 5:4 and 4:5 simply
// aren't in the picker. But that is a coincidence of two lists maintained in
// different places: add 5:4 to IMAGE_RATIOS for Gemini's benefit (it supports it)
// and GPT Image 2 users would silently gain a 2K/4K combination kie rejects.
// This asserts the whole cross-product, so that edit fails here instead of in
// production. If it ever does fail, the fix is not to weaken this test: the
// resolution pill already disables unavailable tiers via imageResolutionsFor(),
// so the UI keeps working — this is the alarm that says the UI is now load-bearing.
test('every ratio × tier the picker can produce is one GPT Image 2 accepts', () => {
    const model = IMAGE_MODELS.find((m) => m.id === 'chatgpt-image-2');
    for (const ratio of IMAGE_RATIOS) {
        const offered = imageResolutionsFor(model.id, ratio);
        for (const tier of model.resolutions) {
            assert.ok(offered.includes(tier),
                `the picker offers ${ratio} @ ${tier}, which kie would reject — disable it in the UI or drop the ratio`);
        }
    }
});

test('a supported tier passes through untouched, and null stays null', () => {
    assert.equal(clampImageResolution('chatgpt-image-2', '16:9', '4K'), '4K');
    assert.equal(clampImageResolution('chatgpt-image-2', '16:9', null), null);
    assert.equal(clampImageResolution('nano-banana-2', '1:1', '2K'), '2K');
});

// The clamp exists for ONE model. Every other image model must reach its
// provider with the request it carried before the clamp existed — including a
// tier outside its own ladder, which the studio never sends but a direct API or
// MCP caller can. Snapping those to the ladder would send Seedream a 1K ask as
// 4K: upward, i.e. the opposite of clamping, and an overbill on any model whose
// price moves per tier.
test('models other than ChatGPT Image 2 are never rewritten', () => {
    assert.equal(clampImageResolution('seedream-5.0-pro', '1:1', '1K'), '1K', 'must NOT snap up to 4K');
    assert.equal(clampImageResolution('nano-banana-2', '1:1', '4K'), '4K', 'Flash caps server-side; we do not rewrite the ask');
    assert.equal(clampImageResolution('nano-banana-pro', '5:4', '4K'), '4K', 'the kie ratio rule must not leak onto Gemini');
    assert.equal(clampImageResolution('cinematic-studio', '4:5', '4K'), '4K');
    assert.equal(clampImageResolution('unknown-model', '1:1', '4K'), '4K');
});

// Within the one model it does govern, the clamp only ever lowers.
test('the clamp never raises a tier', () => {
    for (const ratio of ['5:4', '4:5']) {
        for (const [requested, expected] of [['4K', '1K'], ['2K', '1K'], ['1K', '1K']]) {
            assert.equal(clampImageResolution('chatgpt-image-2', ratio, requested), expected);
        }
    }
});

// Casing must never decide an outcome (the access-request flow canonicalises
// the same way), so a lowercase tier resolves AND comes back canonical — the
// provider only accepts the exact token.
test('the clamp is case-insensitive and returns the canonical tier token', () => {
    assert.equal(clampImageResolution('chatgpt-image-2', '16:9', '2k'), '2K');
    assert.equal(clampImageResolution('chatgpt-image-2', '5:4', '4k'), '1K');
});

test('ChatGPT Image 2 is offered by the studio and stays permission-gated', () => {
    const model = IMAGE_MODELS.find((m) => m.id === 'chatgpt-image-2');
    assert.ok(model, 'the picker must know the model');
    assert.equal(model.gated, true, 'ungated would hand it to everyone the moment it ships');
    assert.equal(model.kind, 'chatgpt_image_2');
    // kie documents 16 reference images; our boundary caps total base64 at 4MB,
    // so 16 is a promise we could not keep. See the comment in constants.js.
    assert.ok(model.maxRefImages <= 16);
});
