// OpenAI adapter (ChatGPT Image 2.5). The network calls are not tested here; the
// three things that silently corrupt a generation are:
//   • size mapping — OpenAI renders exactly three sizes, so every studio ratio
//     must snap to one of them or the request 400s after being priced
//   • error mapping — OpenAI's 429 covers two OPPOSITE conditions (rate limit
//     vs out of credit); retrying the latter pays for a doomed generation
//     three times, exactly the failure kie's mapping exists to prevent
//   • reference conversion — refs are stored Gemini-shaped and must reach the
//     /edits form as raw base64, or every attached ref is silently dropped
import test from 'node:test';
import assert from 'node:assert/strict';
import { sizeFor, buildBody, refParts, mapOpenAiError, variantSlug } from '../lib/gateway/providers/openai.mjs';
import { isRetryable } from '../lib/gateway/queueLogic.mjs';
import { imageRate } from '../lib/gateway/imagePricing.mjs';

test('1K snaps every studio ratio to a recommended size', () => {
    assert.equal(sizeFor(null), 'auto');
    assert.equal(sizeFor('1:1'), '1024x1024');
    assert.equal(sizeFor('1:1', '1K'), '1024x1024');
    for (const landscape of ['3:2', '4:3', '16:9', '21:9', '5:4']) {
        assert.equal(sizeFor(landscape, '1K'), '1536x1024', `${landscape} must render landscape`);
    }
    for (const portrait of ['2:3', '3:4', '9:16', '4:5']) {
        assert.equal(sizeFor(portrait, '1K'), '1024x1536', `${portrait} must render portrait`);
    }
});

test('2K/4K hit the exact documented dimensions where they exist', () => {
    assert.equal(sizeFor('16:9', '4K'), '3840x2160'); // 4K UHD, the pixel ceiling
    assert.equal(sizeFor('1:1', '4K'), '2880x2880');  // sqrt of the ceiling, exact
    assert.equal(sizeFor('16:9', '2K'), '2560x1440');
    assert.equal(sizeFor('1:1', '2K'), '1920x1920');
    assert.equal(sizeFor(null, '2K'), '1920x1920');   // no ratio → square at tier
});

// The documented constraints: multiples of 16, no edge over 3840, total pixels
// within [655360, 8294400], ratio within 1:3–3:1. A violation is a 400 AFTER
// the job was priced and reserved, so every ratio×tier must hold.
test('every custom dimension respects the API constraints at every tier', () => {
    const ratios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
    for (const tier of ['2K', '4K']) {
        for (const ratio of ratios) {
            const [w, h] = sizeFor(ratio, tier).split('x').map(Number);
            assert.ok(w % 16 === 0 && h % 16 === 0, `${ratio}@${tier}: ${w}x${h} must be multiples of 16`);
            assert.ok(w <= 3840 && h <= 3840, `${ratio}@${tier}: edge over 3840`);
            assert.ok(w * h <= 8_294_400, `${ratio}@${tier}: ${w * h} px over the ceiling`);
            assert.ok(w * h >= 655_360, `${ratio}@${tier}: ${w * h} px under the floor`);
            assert.ok(w / h <= 3 && h / w <= 3, `${ratio}@${tier}: outside 1:3–3:1`);
        }
    }
});

test('buildBody pins quality and only sends n when more than one image is asked for', () => {
    const one = buildBody({ prompt: 'a lighthouse', options: { aspectRatio: '16:9', imageCount: 1 } });
    assert.equal(one.model, 'gpt-image-2.5-flare');
    assert.equal(one.size, '1536x1024');
    assert.ok(one.quality, 'quality must be pinned — pricing is flat per image at that quality');
    assert.equal('n' in one, false);
    assert.equal(buildBody({ prompt: 'x', options: { imageCount: 3 } }).n, 3);
});

test('the slug follows the user variant pick, and only on known suffixes', () => {
    assert.equal(variantSlug('gpt-image-2.5-flare', 'sunburst'), 'gpt-image-2.5-sunburst');
    assert.equal(variantSlug('gpt-image-2.5-sunburst', 'flare'), 'gpt-image-2.5-flare');
    assert.equal(variantSlug('gpt-image-2.5-flare', null), 'gpt-image-2.5-flare');
    // A custom route id without a variant suffix must never be mangled.
    assert.equal(variantSlug('my-custom-endpoint', 'sunburst'), 'my-custom-endpoint');
});

test('user quality and variant reach the request body; off-list quality falls to the default', () => {
    const b = buildBody({ prompt: 'x', options: { quality: 'high', variant: 'sunburst' } });
    assert.equal(b.quality, 'high');
    assert.equal(b.model, 'gpt-image-2.5-sunburst');
    assert.equal(buildBody({ prompt: 'x', options: { quality: 'max' } }).quality, 'medium');
});

// Quality scales the price: a user picking high at the medium flat rate would
// bill ~4× under what OpenAI charges — the exact leak QUALITY_FACTORS closes.
test('the rate follows the picked quality', () => {
    const medium = imageRate('chatgpt_image_2_5', 'interactive', '1K');
    assert.equal(imageRate('chatgpt_image_2_5', 'interactive', '1K', 'medium'), medium);
    assert.equal(imageRate('chatgpt_image_2_5', 'interactive', '1K', 'high'), Number((medium * 4).toFixed(4)));
    assert.equal(imageRate('chatgpt_image_2_5', 'interactive', '1K', 'low'), Number((medium * 0.3).toFixed(4)));
    // Kinds without quality tiers ignore the argument entirely.
    assert.equal(imageRate('nano_banana_2', 'interactive', null, 'high'), imageRate('nano_banana_2', 'interactive'));
});

test('refParts turns stored Gemini parts into raw base64, stripping any data: prefix', () => {
    const refs = refParts([
        { text: 'ignored' },
        { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } },
        { inlineData: { mimeType: 'image/png', data: 'data:image/png;base64,BBBB' } },
        { inlineData: { mimeType: 'application/pdf', data: 'CCCC' } },
    ]);
    assert.deepEqual(refs, [
        { mimeType: 'image/jpeg', data: 'AAAA' },
        { mimeType: 'image/png', data: 'BBBB' },
        { mimeType: 'image/png', data: 'CCCC' }, // off-list mime falls back to png
    ]);
});

test('out-of-credit is terminal even though OpenAI sends it as a 429', () => {
    const err = mapOpenAiError(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } });
    assert.equal(isRetryable(err), false);
    assert.match(err.message, /credit/i);
});

test('a genuine rate limit and a server error retry', () => {
    assert.equal(isRetryable(mapOpenAiError(429, { error: { code: 'rate_limit_exceeded', message: 'slow down' } })), true);
    assert.equal(isRetryable(mapOpenAiError(500, null)), true);
});

test('bad input, auth and policy failures are terminal', () => {
    for (const status of [400, 401, 403, 422]) {
        assert.equal(isRetryable(mapOpenAiError(status, { error: { message: 'nope' } })), false, `status ${status} must not retry`);
    }
});

test('a bad key and an unverified org say what to do about it', () => {
    assert.match(mapOpenAiError(401, null).message, /API key/i);
    assert.match(mapOpenAiError(403, null).message, /verified/i);
});
