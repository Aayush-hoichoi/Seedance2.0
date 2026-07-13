import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeImageRequest, IMAGE_LIMITS } from '../lib/gateway/validateImageRequest.mjs';

const B64 = 'aGVsbG8='; // "hello"

test('rejects missing / empty prompt', () => {
    assert.equal(sanitizeImageRequest(null).error, 'A prompt is required.');
    assert.equal(sanitizeImageRequest({}).error, 'A prompt is required.');
    assert.equal(sanitizeImageRequest({ prompt: '   ' }).error, 'A prompt is required.');
});

test('accepts a plain prompt and trims it', () => {
    const r = sanitizeImageRequest({ prompt: '  a red apple ' });
    assert.deepEqual(r.request, { prompt: 'a red apple' });
    assert.equal(r.imageCount, 1);
});

test('caps prompt length', () => {
    const long = 'x'.repeat(IMAGE_LIMITS.MAX_PROMPT + 1);
    assert.match(sanitizeImageRequest({ prompt: long }).error, /too long/);
});

test('clamps imageCount to 1..MAX', () => {
    assert.equal(sanitizeImageRequest({ prompt: 'p' }, { imageCount: 0 }).imageCount, 1);
    assert.equal(sanitizeImageRequest({ prompt: 'p' }, { imageCount: -5 }).imageCount, 1);
    assert.equal(sanitizeImageRequest({ prompt: 'p' }, { imageCount: 9999 }).imageCount, IMAGE_LIMITS.MAX_IMAGE_COUNT);
    assert.equal(sanitizeImageRequest({ prompt: 'p' }, { imageCount: 2.9 }).imageCount, 2);
});

test('accepts valid inline reference images', () => {
    const r = sanitizeImageRequest({
        prompt: 'combine these',
        parts: [{ text: 'combine these' }, { inlineData: { mimeType: 'image/jpeg', data: B64 } }],
    });
    assert.equal(r.error, undefined);
    assert.equal(r.request.parts.length, 2);
    assert.deepEqual(r.request.parts[1], { inlineData: { mimeType: 'image/jpeg', data: B64 } });
});

test('strips an accidental data: URL prefix from base64', () => {
    const r = sanitizeImageRequest({
        prompt: 'p',
        parts: [{ inlineData: { mimeType: '', data: `data:image/png;base64,${B64}` } }],
    });
    assert.deepEqual(r.request.parts.find((p) => p.inlineData).inlineData, { mimeType: 'image/png', data: B64 });
});

test('injects the prompt as a text part when parts omit it', () => {
    const r = sanitizeImageRequest({
        prompt: 'edit',
        parts: [{ inlineData: { mimeType: 'image/png', data: B64 } }],
    });
    assert.deepEqual(r.request.parts[0], { text: 'edit' });
});

test('rejects non-image reference mime types', () => {
    assert.match(sanitizeImageRequest({
        prompt: 'p', parts: [{ inlineData: { mimeType: 'application/pdf', data: B64 } }],
    }).error, /must be images/);
});

test('rejects invalid base64 in a reference', () => {
    assert.match(sanitizeImageRequest({
        prompt: 'p', parts: [{ inlineData: { mimeType: 'image/png', data: 'not base64!!!' } }],
    }).error, /not valid base64/);
});

test('rejects a malformed part (no data)', () => {
    assert.match(sanitizeImageRequest({
        prompt: 'p', parts: [{ inlineData: { mimeType: 'image/png' } }],
    }).error, /malformed/);
});

test('caps reference-image count at MAX_REF_IMAGES', () => {
    const img = { inlineData: { mimeType: 'image/png', data: B64 } };
    const parts = [{ text: 'p' }, img, img, img, img];
    assert.match(sanitizeImageRequest({ prompt: 'p', parts }).error, /at most 3/);
});

test('caps total base64 size', () => {
    const big = 'A'.repeat(IMAGE_LIMITS.MAX_TOTAL_B64 + 4);
    assert.match(sanitizeImageRequest({
        prompt: 'p', parts: [{ inlineData: { mimeType: 'image/png', data: big } }],
    }).error, /too large/);
});

test('rejects a non-array parts field', () => {
    assert.match(sanitizeImageRequest({ prompt: 'p', parts: 'nope' }).error, /malformed/);
});
