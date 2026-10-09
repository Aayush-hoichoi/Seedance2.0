import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeStudioHistory } from '../lib/seedance/historyMerge.mjs';

const fresh = {
    taskId: 'job:42', mediaType: 'image', projectId: 3, status: 'succeeded',
    imageUrl: 'https://media.example/images/job-42-0.png?fresh=1',
    imageUrls: ['https://media.example/images/job-42-0.png?fresh=1', 'https://media.example/images/job-42-1.png?fresh=1'],
};
const cached = {
    id: 'srv-job:42', taskId: 'job:42', mediaType: 'image', projectId: 3,
    status: 'done', imageUrl: 'https://media.example/images/job-42-0.png?expired=1',
    imageUrls: ['https://media.example/images/job-42-0.png?expired=1', 'https://media.example/images/job-42-1.png?expired=1'],
    prompt: 'My prompt', options: { ratio: '16:9' }, refs: [{ name: 'My reference' }],
    liked: true, deleted: true, deletedAt: 123, createdAt: 100,
};

for (const local of [false, true]) {
    test(`fresh gallery image URLs replace expired ${local ? 'locally generated' : 'server-restored'} history URLs without duplicating or resetting the card`, () => {
        const before = { ...cached, ...(local ? { id: 'local-42', taskId: null, genId: 42 } : {}) };
        const merged = mergeStudioHistory([before], [fresh]);
        assert.equal(merged.length, 1);
        assert.equal(merged[0].imageUrl, fresh.imageUrl);
        assert.deepEqual(merged[0].imageUrls, fresh.imageUrls);
        for (const key of ['id', 'taskId', 'genId', 'prompt', 'options', 'refs', 'liked', 'deleted', 'deletedAt', 'createdAt']) {
            assert.deepEqual(merged[0][key], before[key], key);
        }
    });
}

test('image refresh clears stale multi-image URLs when the server returns one image', () => {
    const [merged] = mergeStudioHistory([cached], [{ ...fresh, imageUrls: null }]);
    assert.equal(merged.imageUrl, fresh.imageUrl);
    assert.equal(merged.imageUrls, null);
});

test('a missing server image does not erase a cached result', () => {
    const [merged] = mergeStudioHistory([cached], [{ ...fresh, imageUrl: null, imageUrls: null }]);
    assert.equal(merged.imageUrl, cached.imageUrl);
    assert.deepEqual(merged.imageUrls, cached.imageUrls);
});

test('server-only image history still creates a single usable card', () => {
    const merged = mergeStudioHistory([], [fresh]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 'srv-job:42');
    assert.equal(merged[0].status, 'done');
    assert.equal(merged[0].imageUrl, fresh.imageUrl);
    assert.deepEqual(merged[0].imageUrls, fresh.imageUrls);
});

test('image generation identity can match a legacy task using the authoritative gateway id', () => {
    const [merged, duplicate] = mergeStudioHistory([{ ...cached, id: 'local-42', taskId: null, genId: 42 }], [{ ...fresh, taskId: 'legacy-image-task', gatewayId: 42 }]);
    assert.equal(duplicate, undefined);
    assert.equal(merged.imageUrl, fresh.imageUrl);
});

test('a completed server image reconciles a cached error and dead blob URL', () => {
    const [merged] = mergeStudioHistory([{ ...cached, imageUrl: 'blob:previous-session', status: 'error', error: 'Network interrupted', expired: true }], [fresh]);
    assert.equal(merged.imageUrl, fresh.imageUrl);
    assert.equal(merged.status, 'done');
    assert.equal(merged.error, null);
    assert.equal(merged.expired, false);
});

test('a different generation cannot replace a cached image and repeat pages add no duplicates', () => {
    const other = { ...fresh, taskId: 'job:99', imageUrl: 'another-image', imageUrls: null };
    const once = mergeStudioHistory([cached], [other]);
    assert.equal(once.length, 2);
    assert.equal(once.find((j) => j.id === cached.id).imageUrl, cached.imageUrl);
    const twice = mergeStudioHistory(once, [other]);
    assert.equal(twice.length, 2);
    assert.equal(twice.find((j) => j.id === cached.id).imageUrl, cached.imageUrl);
});

test('video timing and project hydration keep the local playback URL and user choices', () => {
    const before = { ...cached, id: 'srv-video', taskId: 'video', mediaType: 'video', imageUrl: null, imageUrls: null, videoUrl: 'current-video', projectId: null };
    const [merged] = mergeStudioHistory([before], [{ taskId: 'video', mediaType: 'video', archiveUrl: 'other-video', projectId: 9, gatewayId: 7, submittedAt: 'start', finishedAt: 'finish' }]);
    assert.equal(merged.videoUrl, before.videoUrl);
    assert.equal(merged.projectId, 9);
    assert.equal(merged.gatewayId, 7);
    assert.equal(merged.submittedAt, 'start');
    assert.equal(merged.finishedAt, 'finish');
    assert.equal(merged.liked, true);
    assert.equal(merged.deleted, true);
});

const cachedVideo = {
    id: 'local-video', taskId: 'video', mediaType: 'video', status: 'done',
    archiveKey: 'videos/video.mp4',
    videoUrl: 'https://bucket.tos-ap-southeast-1.bytepluses.com/videos/video.mp4?X-Tos-Date=20200101T000000Z&X-Tos-Expires=604800',
    expired: true, createdAt: 100, liked: true, deleted: true,
    prompt: 'Local prompt', options: { resolution: '4k' }, refs: [{ name: 'Reference' }],
};
const freshVideo = {
    taskId: 'video', mediaType: 'video', status: 'succeeded',
    archiveUrl: 'https://video.example.cloudfront.net/videos/video.mp4?fresh=1',
};

test('a fresh successful archive row replaces an expired cached video and resets its expired flag', () => {
    const before = Date.now();
    const result = mergeStudioHistory([cachedVideo], [freshVideo]);
    assert.equal(result.length, 1);
    assert.equal(result[0].videoUrl, freshVideo.archiveUrl);
    assert.equal(result[0].expired, false);
    assert.ok(result[0].urlRefreshedAt >= before);
    for (const key of ['id', 'taskId', 'archiveKey', 'createdAt', 'liked', 'deleted', 'prompt', 'options', 'refs']) {
        assert.deepEqual(result[0][key], cachedVideo[key], key);
    }
});

test('fresh gallery signatures renew stale legacy archived links while preserving working provider URLs', () => {
    const [archived] = mergeStudioHistory([{ ...cachedVideo, videoUrl: 'current-archive', expired: false }], [freshVideo]);
    assert.equal(archived.videoUrl, freshVideo.archiveUrl);
    const provider = { ...cachedVideo, archiveKey: null, videoUrl: 'https://provider.volces.com/current.mp4', expired: false };
    const [working] = mergeStudioHistory([provider], [freshVideo]);
    assert.equal(working.videoUrl, provider.videoUrl);
    assert.equal(working.urlRefreshedAt, undefined);
});

test('a valid cached archive signature is preserved so gallery hydration cannot restart its preview', () => {
    const videoUrl = 'https://video.example.cloudfront.net/videos/video.mp4?X-Tos-Date=20990101T000000Z&X-Tos-Expires=604800';
    const [merged] = mergeStudioHistory([{ ...cachedVideo, videoUrl, expired: false }], [freshVideo]);
    assert.equal(merged.videoUrl, videoUrl);
    assert.equal(merged.urlRefreshedAt, undefined);
});

test('an expired signed or missing video URL can be repaired without inventing an archive key', () => {
    for (const videoUrl of [cachedVideo.videoUrl, null]) {
        const [merged] = mergeStudioHistory([{ ...cachedVideo, archiveKey: null, videoUrl, expired: false }], [freshVideo]);
        assert.equal(merged.videoUrl, freshVideo.archiveUrl);
        assert.equal(merged.archiveKey, null);
    }
});

test('only a successful row with an archive URL may reset an expired video', () => {
    for (const row of [{ ...freshVideo, status: 'running' }, { ...freshVideo, status: 'failed' }, { ...freshVideo, archiveUrl: null }]) {
        const [merged] = mergeStudioHistory([cachedVideo], [row]);
        assert.equal(merged.videoUrl, cachedVideo.videoUrl);
        assert.equal(merged.expired, true);
        assert.equal(merged.urlRefreshedAt, undefined);
    }
});
