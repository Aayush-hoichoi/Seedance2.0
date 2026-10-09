import test from 'node:test';
import assert from 'node:assert/strict';
import { toItem, imageUrlsFromResult } from '../lib/seedance/galleryItem.mjs';

test('toItem maps a video row (no AK/SK in env → archiveUrl null) and an image row', () => {
    const video = toItem({ task_id: 't1', category: 'video', model_id: 'seedance-2.0-mini', status: 'succeeded', user_prompt: 'cat', liked: true, created_at: '2026-07-16', exr_url: 'https://byteplus.example/t1.exr', exr_archive_key: null });
    assert.equal(video.mediaType, 'video');
    assert.equal(video.taskId, 't1');
    assert.equal(video.liked, true);
    assert.equal(video.exrUrl, 'https://byteplus.example/t1.exr');
    const image = toItem({ task_id: 't2', category: 'image', image_prompt: 'dog', image_key: 'images/job-9-0.png', project_id: 9, project_name: 'Film A' });
    assert.equal(image.mediaType, 'image');
    assert.equal(image.prompt, 'dog');
    assert.equal(image.archiveUrl, null);
    assert.equal(image.projectId, 9);
    assert.equal(image.projectName, 'Film A');
    assert.equal(image.gatewayId, null);
    assert.equal(image.submittedAt, null);
    assert.equal(image.finishedAt, null);
});

test('gallery items preserve authoritative timing independently of their history cursor date', () => {
    const item = toItem({
        task_id: 'cgt-timing', category: 'video', status: 'succeeded', gateway_id: 27,
        created_at: '2026-10-09T10:01:00Z',
        submitted_at: '2026-10-09T10:00:00Z', finished_at: '2026-10-09T10:07:25Z',
    });
    assert.equal(item.gatewayId, 27);
    assert.equal(item.createdAt, '2026-10-09T10:01:00Z');
    assert.equal(item.submittedAt, '2026-10-09T10:00:00Z');
    assert.equal(item.finishedAt, '2026-10-09T10:07:25Z');
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
