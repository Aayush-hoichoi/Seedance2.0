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

test('a Failed asset with no Error gives an honest no-reason explanation (not "format/size")', async () => {
    const { pollAssetActive } = await import('../lib/byteplus/assetsServer.js');
    await withFetch({ Result: { Id: 'asset-2', Status: 'Failed' } }, async () => {
        await assert.rejects(
            () => pollAssetActive('asset-2', { intervalMs: 1 }),
            /didn.t pass verification|no reason/i,
        );
    });
});

test('getAsset reads the reason from a non-Error field when Error is empty', async () => {
    const { getAsset } = await import('../lib/byteplus/assetsServer.js');
    await withFetch({ Result: { Id: 'a3', Status: 'Failed', FailReason: 'InputVideoSensitiveContentDetected' } }, async () => {
        const a = await getAsset('a3');
        assert.equal(a.error, 'InputVideoSensitiveContentDetected'); // not lost as null
    });
});

test('the moderation rejection reads as a source-video problem, not a prompt one', () => {
    const shown = friendlyError(`Source video verification failed — ${FAILED_BODY.Result.Error.Message}`);
    assert.match(shown, /source video/i);
    assert.doesNotMatch(shown, /Request ID/i);
    // Must not send the user editing the prompt — the prompt is not the cause.
    assert.doesNotMatch(shown, /adjust the prompt/i);
});

test('friendlyError maps the common provider errors to actionable copy', () => {
    // output-audio moderation → guide to turning Audio off, NOT a prompt edit
    const audio = friendlyError('The request failed because the output audio may contain sensitive information. Request id: 021');
    assert.match(audio, /Audio off/i);
    assert.doesNotMatch(audio, /swap the media/i); // the run succeeded; don't blame the input
    assert.doesNotMatch(audio, /Request id/i);     // provider id stripped
    // output-video copyright
    assert.match(friendlyError('The request failed because the output video may be related to copyright restrictions.'), /copyright/i);
    // a reference image flagged as a real person
    assert.match(friendlyError('The request failed because the input image may contain real person.'), /reference image/i);
    // an expired asset:// reference
    assert.match(friendlyError('content[1].image_url.url is not valid: The specified asset asset-x is not found.'), /expired|re-attach|Reuse/i);
    // the no-reason verification fallback
    assert.match(friendlyError('The source media didn’t pass verification and the provider returned no reason (usually a moderation flag on the content).'), /moderation flag/i);
});
