import test from 'node:test';
import assert from 'node:assert/strict';
import { isStudioVideoUrlStale } from '../lib/seedance/videoUrlState.mjs';

const now = Date.parse('2026-10-10T12:00:00Z');
const hour = 60 * 60 * 1000;
const signed = (origin, stamp) => `${origin}/videos/task.mp4?X-Tos-Date=${stamp}&X-Tos-Expires=604800&X-Tos-Signature=fixture`;

for (const origin of ['https://bucket.tos-ap-southeast-1.bytepluses.com', 'https://video.example.cloudfront.net']) {
    test(`an archived ${new URL(origin).hostname} URL still expires`, () => {
        const job = { archiveKey: 'videos/task.mp4', videoUrl: signed(origin, '20260930T114443Z'), createdAt: now - 30 * hour };
        assert.equal(isStudioVideoUrlStale(job, now), true);
        assert.equal(isStudioVideoUrlStale({ ...job, videoUrl: signed(origin, '20261010T120000Z') }, now), false);
    });
}

test('archived signatures are refreshed inside the existing five-minute expiry window', () => {
    const job = { archiveKey: 'videos/task.mp4', videoUrl: signed('https://video.example.cloudfront.net', '20261003T120400Z') };
    assert.equal(isStudioVideoUrlStale(job, now), true);
});

test('provider URLs retain the 20-hour age fallback and respect a successful refresh', () => {
    const job = { videoUrl: 'https://provider.volces.com/task.mp4', createdAt: now - 21 * hour };
    assert.equal(isStudioVideoUrlStale(job, now), true);
    assert.equal(isStudioVideoUrlStale({ ...job, createdAt: now - 19 * hour }, now), false);
    assert.equal(isStudioVideoUrlStale({ ...job, urlRefreshedAt: now - hour }, now), false);
});

test('a missing cached video URL requires resolution even when the archive key exists', () => {
    assert.equal(isStudioVideoUrlStale({ archiveKey: 'videos/task.mp4', videoUrl: null, createdAt: now }, now), true);
    assert.equal(isStudioVideoUrlStale({ archiveKey: 'videos/task.mp4', videoUrl: '', expired: true, createdAt: now }, now), true);
});

test('a fresh signed URL does not inherit the generation age even without an archive key', () => {
    assert.equal(isStudioVideoUrlStale({ videoUrl: signed('https://video.example.cloudfront.net', '20261010T120000Z'), createdAt: now - 200 * hour }, now), false);
});

test('a provider fallback can expire even when a separate archive key is known', () => {
    assert.equal(isStudioVideoUrlStale({ archiveKey: 'videos/task.mp4', videoUrl: 'https://provider.volces.com/task.mp4', createdAt: now - 21 * hour }, now), true);
});
