import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createTaskToken,
    readTaskToken,
    createQueueTaskToken,
    readQueueTaskToken,
    submitEnhancement,
    validateSourceUrl,
} from '../lib/byteplus/vodEnhance.mjs';
import { presignGetUrl, TOS_ENDPOINT } from '../lib/byteplus/tosSign.js';

test('EXR task tokens are signed and tied to the logged-in user', () => {
    const previous = process.env.BYTEPLUS_VOD_TASK_TOKEN_SECRET;
    process.env.BYTEPLUS_VOD_TASK_TOKEN_SECRET = 'test-secret';
    try {
        const token = createTaskToken({ providerTaskId: 'task-123', userId: 'user-1' });
        assert.deepEqual(readTaskToken(token, 'user-1'), { providerTaskId: 'task-123', userId: 'user-1' });
        assert.equal(readTaskToken(token, 'user-2'), null);
        assert.equal(readTaskToken(`${token}x`, 'user-1'), null);
    } finally {
        if (previous === undefined) delete process.env.BYTEPLUS_VOD_TASK_TOKEN_SECRET;
        else process.env.BYTEPLUS_VOD_TASK_TOKEN_SECRET = previous;
    }
});

test('EXR source URLs are limited to BytePlus media hosts', () => {
    assert.equal(validateSourceUrl('https://example.com/video.mp4'), false);
    assert.equal(validateSourceUrl('http://cdn.bytepluses.com/video.mp4'), true);
    assert.equal(validateSourceUrl('https://media.volces.com/video.mp4'), true);
    assert.equal(validateSourceUrl('https://bytepluses.com.evil.example/video.mp4'), false);
    assert.equal(validateSourceUrl('file:///tmp/video.mp4'), false);
});

test('queue task tokens expose only the queue id and stay user-scoped', () => {
    const previous = process.env.BYTEPLUS_VOD_TASK_TOKEN_SECRET;
    process.env.BYTEPLUS_VOD_TASK_TOKEN_SECRET = 'test-secret';
    try {
        const token = createQueueTaskToken({ queueId: 42, userId: 'user-1' });
        assert.deepEqual(readQueueTaskToken(token, 'user-1'), { queueId: 42, userId: 'user-1' });
        assert.equal(readQueueTaskToken(token, 'user-2'), null);
    } finally {
        if (previous === undefined) delete process.env.BYTEPLUS_VOD_TASK_TOKEN_SECRET;
        else process.env.BYTEPLUS_VOD_TASK_TOKEN_SECRET = previous;
    }
});

test('EXR submission sends the professional 16-bit request', async () => {
    const previousKey = process.env.BYTEPLUS_VOD_MEDIAKIT_API_KEY;
    const previousFetch = globalThis.fetch;
    process.env.BYTEPLUS_VOD_MEDIAKIT_API_KEY = 'test-vod-key';
    let call;
    globalThis.fetch = async (url, init) => {
        call = { url, init };
        return new Response(JSON.stringify({ task_id: 'task-exr-1', request_id: 'request-1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };
    try {
        const result = await submitEnhancement({
            videoUrl: 'https://cdn.bytepluses.com/video.mp4',
            requestBody: { _billing: { durationSeconds: 10, estimatedCostUsd: 2.7548 } },
        });
        assert.deepEqual(result, { taskId: 'task-exr-1', requestId: 'request-1' });
        assert.equal(call.url, 'https://mediakit.ap-southeast-1.bytepluses.com/api/v1/tools/enhance-video');
        assert.equal(call.init.method, 'POST');
        assert.equal(call.init.headers.Authorization, 'Bearer test-vod-key');
        assert.deepEqual(JSON.parse(call.init.body), {
            scene: 'common',
            tool_version: 'professional',
            resolution: '4k',
            bitrate_level: 'high',
            fps: 24,
            project: 'default',
            persist: true,
            bit_depth: 16,
            output_format: 'EXR',
            video_url: 'https://cdn.bytepluses.com/video.mp4',
        });
    } finally {
        globalThis.fetch = previousFetch;
        if (previousKey === undefined) delete process.env.BYTEPLUS_VOD_MEDIAKIT_API_KEY;
        else process.env.BYTEPLUS_VOD_MEDIAKIT_API_KEY = previousKey;
    }
});

test('EXR submission removes gallery metadata before calling BytePlus', async () => {
    const previousKey = process.env.BYTEPLUS_VOD_MEDIAKIT_API_KEY;
    const previousFetch = globalThis.fetch;
    process.env.BYTEPLUS_VOD_MEDIAKIT_API_KEY = 'test-vod-key';
    let body;
    globalThis.fetch = async (_url, init) => {
        body = JSON.parse(init.body);
        return new Response(JSON.stringify({ task_id: 'task-exr-2' }), { status: 200 });
    };
    try {
        await submitEnhancement({
            videoUrl: 'https://cdn.bytepluses.com/video.mp4',
            requestBody: { _gallery: { sourceTaskId: 'video-1' }, output_format: 'EXR' },
        });
        assert.equal(body._gallery, undefined);
        assert.equal(body.output_format, 'EXR');
    } finally {
        globalThis.fetch = previousFetch;
        if (previousKey === undefined) delete process.env.BYTEPLUS_VOD_MEDIAKIT_API_KEY;
        else process.env.BYTEPLUS_VOD_MEDIAKIT_API_KEY = previousKey;
    }
});

function configureCdn(t) {
    const values = {
        VIDEO_CDN_DOMAIN: 'video-cdn.example.com',
        TOS_BUCKET: 'test-video-bucket',
        BYTEPLUS_VOD_MEDIAKIT_API_KEY: 'test-vod-key',
    };
    for (const [key, value] of Object.entries(values)) {
        const previous = process.env[key];
        process.env[key] = value;
        t.after(() => {
            if (previous === undefined) delete process.env[key];
            else process.env[key] = previous;
        });
    }
}

test('EXR/upscale accept only the configured CDN video origin', (t) => {
    configureCdn(t);
    assert.equal(validateSourceUrl('https://video-cdn.example.com/videos/task.mp4'), true);
    for (const url of [
        'https://other.cloudfront.net/videos/task.mp4',
        'https://video-cdn.example.com.evil.example/videos/task.mp4',
        'http://video-cdn.example.com/videos/task.mp4',
        'https://user:password@video-cdn.example.com/videos/task.mp4',
        'https://video-cdn.example.com:8443/videos/task.mp4',
        'https://video-cdn.example.com/uploads/reference.mp4',
        'https://video-cdn.example.com/exr/output.mov',
    ]) assert.equal(validateSourceUrl(url), false, url);
});

for (const upscale of [false, true]) {
    test(`${upscale ? 'Upscale' : 'EXR'} submission unwraps CDN playback to the original signed TOS source`, async (t) => {
        configureCdn(t);
        const original = presignGetUrl({
            host: `test-video-bucket.${TOS_ENDPOINT}`, path: '/videos/task-123.mp4',
            ak: 'test-ak', sk: 'test-sk', expiresSec: 604800, date: new Date('2026-10-09T12:00:00Z'),
        });
        const cdn = new URL(original);
        cdn.hostname = process.env.VIDEO_CDN_DOMAIN;
        for (const [key, value] of Object.entries({ Expires: '1800000000', Signature: 'viewer-signature', 'Key-Pair-Id': 'viewer-key', unrelated: 'drop-me' })) cdn.searchParams.set(key, value);
        let body;
        t.mock.method(globalThis, 'fetch', async (_url, init) => {
            body = JSON.parse(init.body);
            return Response.json({ task_id: 'task-cdn-source' });
        });
        await submitEnhancement({
            videoUrl: cdn.toString(),
            requestBody: upscale
                ? { _upscale: true, _billing: {}, _gallery: {}, resolution: '1080p', output_format: 'MP4' }
                : { _billing: {}, _gallery: {}, output_format: 'EXR' },
        });
        const sent = new URL(body.video_url);
        const origin = new URL(original);
        assert.equal(sent.origin, origin.origin);
        assert.equal(sent.pathname, origin.pathname);
        assert.deepEqual([...sent.searchParams].sort(), [...origin.searchParams].sort());
        assert.equal(body.output_format, upscale ? 'MP4' : 'EXR');
        assert.equal(body._upscale, undefined);
        assert.equal(body._billing, undefined);
        assert.equal(body._gallery, undefined);
    });
}
