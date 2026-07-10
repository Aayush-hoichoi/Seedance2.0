import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVideoRefs } from '../lib/seedance/assetsClient.js';

const fakeRegister = async ({ url }) => ({ url: 'asset://asset-test-1', assetId: 'asset-test-1', from: url });

test('swaps raw video URLs for asset:// refs', async () => {
    const items = [{ kind: 'video', url: 'https://tos.example/v.mp4', role: 'reference_video', tosKey: 'uploads/v.mp4' }];
    const out = await resolveVideoRefs(items, fakeRegister);
    assert.equal(out[0].url, 'asset://asset-test-1');
    assert.equal(out[0].assetId, 'asset-test-1');
    assert.equal(out[0].tosKey, 'uploads/v.mp4'); // tosKey preserved for Reuse/thumbnails
});

test('leaves images, audio and existing asset:// videos untouched', async () => {
    const items = [
        { kind: 'image', url: 'https://tos.example/i.png' },
        { kind: 'audio', url: 'https://tos.example/a.mp3' },
        { kind: 'video', url: 'asset://asset-already' },
    ];
    const out = await resolveVideoRefs(items, async () => { throw new Error('must not be called'); });
    assert.deepEqual(out, items);
});

test('does not mutate the input items', async () => {
    const item = { kind: 'video', url: 'https://tos.example/v.mp4' };
    await resolveVideoRefs([item], fakeRegister);
    assert.equal(item.url, 'https://tos.example/v.mp4');
});

test('propagates registration failures', async () => {
    const items = [{ kind: 'video', url: 'https://tos.example/v.mp4' }];
    await assert.rejects(
        () => resolveVideoRefs(items, async () => { throw new Error('quota'); }),
        /quota/,
    );
});
