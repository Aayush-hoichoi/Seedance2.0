import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyError } from '../lib/seedance/friendlyError.js';

// A Failed asset carries the ONLY explanation BytePlus gives, in Result.Error.
// Before this, pollAssetActive threw a generic "check the format/size/content
// rules" line, so a moderation rejection was indistinguishable from a bad file.
const FAILED_BODY = {
    Result: {
        Id: 'asset-1',
        Status: 'Failed',
        Error: {
            Code: 'InputVideoSensitiveContentDetected',
            Message: 'The request failed because the input video may contain sensitive information. Request ID: 2026072115_asset-1',
        },
    },
};

async function withFetch(body, fn) {
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => body });
    try { return await fn(); } finally { global.fetch = realFetch; }
}

test('pollAssetActive surfaces the provider reason for a Failed asset', async () => {
    process.env.ARK_AK = 'test-ak';
    process.env.ARK_SK = 'test-sk';
    const { pollAssetActive } = await import('../lib/byteplus/assetsServer.js');
    await withFetch(FAILED_BODY, async () => {
        await assert.rejects(
            () => pollAssetActive('asset-1', { intervalMs: 1 }),
            /input video may contain sensitive information/i,
        );
    });
});

test('a Failed asset with no Error still gets the generic explanation', async () => {
    const { pollAssetActive } = await import('../lib/byteplus/assetsServer.js');
    await withFetch({ Result: { Id: 'asset-2', Status: 'Failed' } }, async () => {
        await assert.rejects(
            () => pollAssetActive('asset-2', { intervalMs: 1 }),
            /format\/size\/content rules/i,
        );
    });
});

test('the moderation rejection reads as a source-video problem, not a prompt one', () => {
    const shown = friendlyError(`Source video verification failed — ${FAILED_BODY.Result.Error.Message}`);
    assert.match(shown, /source video/i);
    assert.doesNotMatch(shown, /Request ID/i);
    // Must not send the user editing the prompt — the prompt is not the cause.
    assert.doesNotMatch(shown, /adjust the prompt/i);
});
