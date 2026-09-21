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
        const result = await submitEnhancement({ videoUrl: 'https://cdn.bytepluses.com/video.mp4' });
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
