import test from 'node:test';
import assert from 'node:assert/strict';
import { toItem, imageUrlsFromResult } from '../lib/seedance/galleryItem.mjs';

test('toItem maps a video row (no AK/SK in env → archiveUrl null) and an image row', () => {
    const video = toItem({ task_id: 't1', category: 'video', model_id: 'seedance-2.0-mini', status: 'succeeded', user_prompt: 'cat', liked: true, created_at: '2026-07-16' });
    assert.equal(video.mediaType, 'video');
    assert.equal(video.taskId, 't1');
    assert.equal(video.liked, true);
    const image = toItem({ task_id: 't2', category: 'image', image_prompt: 'dog', image_key: 'images/job-9-0.png' });
    assert.equal(image.mediaType, 'image');
    assert.equal(image.prompt, 'dog');
    assert.equal(image.archiveUrl, null);
});

test('imageUrlsFromResult: url entries pass through; key entries need creds (none in test env → dropped); b64 and junk skipped', () => {
    assert.deepEqual(imageUrlsFromResult(null), []);
    assert.deepEqual(imageUrlsFromResult({ images: 'nope' }), []);
    const urls = imageUrlsFromResult({ images: [
        { url: 'https://cdn.example/x.png' },
        { key: 'images/job-1-0.png' }, // presignKey → null without ARK_AK/SK
        { b64: 'aGk=', mimeType: 'image/png' },
        null,
    ] });
    assert.deepEqual(urls, ['https://cdn.example/x.png']);
});
