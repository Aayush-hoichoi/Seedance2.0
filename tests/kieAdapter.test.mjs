// kie.ai adapter (ChatGPT Image 2). The network calls are not tested here; the
// three things that silently corrupt a generation are:
//   • slug selection — sending input_urls to the text-to-image slug is a 422,
//     and sending none to image-to-image is a missing-required-field error
//   • result parsing — resultJson is a JSON *string*, not an object
//   • error mapping — kie reports failures inside an HTTP 200 body, and its
//     501/505 codes would be RETRIED by isRetryable() if passed through as
//     status, paying for the same doomed generation three times

import test from 'node:test';
import assert from 'node:assert/strict';
import { slugFor, buildInput, parseResultUrls, mapKieCode, refDataUrls } from '../lib/gateway/providers/kie.mjs';
import { isRetryable } from '../lib/gateway/queueLogic.mjs';

test('the slug follows the presence of reference images', () => {
    assert.equal(slugFor('gpt-image-2-text-to-image', false), 'gpt-image-2-text-to-image');
    assert.equal(slugFor('gpt-image-2-text-to-image', true), 'gpt-image-2-image-to-image');
});

test('buildInput sends prompt-only for text-to-image', () => {
    const input = buildInput({ prompt: 'a lighthouse', options: { aspectRatio: '16:9', imageSize: '2K' } });
    assert.deepEqual(input, { prompt: 'a lighthouse', aspect_ratio: '16:9', resolution: '2K' });
});

test('buildInput carries reference URLs as input_urls', () => {
    const input = buildInput({
        prompt: 'put it on a beach',
        options: { aspectRatio: '4:3', imageSize: '1K' },
        inputUrls: ['https://files.example/a.png', 'https://files.example/b.png'],
    });
    assert.deepEqual(input.input_urls, ['https://files.example/a.png', 'https://files.example/b.png']);
});

// 5:4 @ 4K is a 422 at task creation (live-probed — see constants.js).
// enqueue.mjs clamps first; this is the adapter's own backstop.
test('buildInput never asks for a resolution the ratio cannot render', () => {
    assert.equal(buildInput({ prompt: 'x', options: { aspectRatio: '5:4', imageSize: '4K' } }).resolution, '1K');
    assert.equal(buildInput({ prompt: 'x', options: { aspectRatio: '1:1', imageSize: '4K' } }).resolution, '4K');
    assert.equal(buildInput({ prompt: 'x', options: { aspectRatio: '16:9', imageSize: '4K' } }).resolution, '4K');
});

test('an omitted option is left out entirely so kie applies its own default', () => {
    assert.deepEqual(buildInput({ prompt: 'x', options: {} }), { prompt: 'x' });
});

test('refDataUrls turns stored Gemini parts into data URIs, and leaves ready ones alone', () => {
    const urls = refDataUrls([
        { text: 'ignored' },
        { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } },
        { inlineData: { mimeType: 'image/png', data: 'data:image/png;base64,BBBB' } },
    ]);
    assert.deepEqual(urls, ['data:image/jpeg;base64,AAAA', 'data:image/png;base64,BBBB']);
});

test('resultJson is a JSON string and is parsed, not read as an object', () => {
    assert.deepEqual(parseResultUrls('{"resultUrls":["https://x/1.png"]}'), ['https://x/1.png']);
    assert.deepEqual(parseResultUrls({ resultUrls: ['https://x/2.png'] }), ['https://x/2.png']);
    assert.deepEqual(parseResultUrls('not json'), []);
    assert.deepEqual(parseResultUrls(null), []);
});

test('a permanent kie failure is terminal, so we never pay for it three times', () => {
    for (const code of [401, 402, 404, 422, 433, 501, 505]) {
        assert.equal(isRetryable(mapKieCode(code, 'nope')), false, `code ${code} must not retry`);
    }
});

test('a transient kie failure retries', () => {
    for (const code of [429, 455, 500]) {
        assert.equal(isRetryable(mapKieCode(code, 'later')), true, `code ${code} must retry`);
    }
});

test('an unclassifiable code fails terminally rather than spending money on a guess', () => {
    assert.equal(isRetryable(mapKieCode(499, 'who knows')), false);
});

test('credit exhaustion and a bad key say what to do about it', () => {
    assert.match(mapKieCode(402).message, /credits/i);
    assert.match(mapKieCode(401).message, /API key/i);
});
