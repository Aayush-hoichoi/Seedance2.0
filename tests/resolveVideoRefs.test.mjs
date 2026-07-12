import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVideoRefs, resolveSensitiveRefs, createWithQuotaRecovery } from '../lib/seedance/assetsClient.js';

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

test('quota recovery: sweeps 1h and retries', async () => {
    const calls = [];
    let attempt = 0;
    const create = async () => {
        if (++attempt === 1) throw new Error('Asset quota exceeded: the shared pool for projects without explicit allocation is full.');
        return 'asset-1';
    };
    const cleanup = async ({ maxAgeHours }) => { calls.push(maxAgeHours); return 3; };
    assert.equal(await createWithQuotaRecovery(create, cleanup), 'asset-1');
    assert.deepEqual(calls, [1]);
});

test('quota recovery: escalates to a minutes-old sweep when the 1h sweep frees nothing', async () => {
    const calls = [];
    let attempt = 0;
    const create = async () => {
        if (++attempt === 1) throw new Error('quota exceeded');
        return 'asset-2';
    };
    const cleanup = async ({ maxAgeHours }) => { calls.push(maxAgeHours); return 0; };
    assert.equal(await createWithQuotaRecovery(create, cleanup), 'asset-2');
    assert.deepEqual(calls, [1, 5 / 60]);
});

test('quota recovery: still-full pool surfaces an actionable message', async () => {
    const create = async () => { throw new Error('Asset quota exceeded'); };
    const cleanup = async () => 0;
    await assert.rejects(() => createWithQuotaRecovery(create, cleanup), /BytePlus console/);
});

test('quota recovery: non-quota errors pass through untouched', async () => {
    const create = async () => { throw new Error('boom'); };
    await assert.rejects(() => createWithQuotaRecovery(create, async () => { throw new Error('must not sweep'); }), /boom/);
});

test('resolveSensitiveRefs swaps raw image and video URLs in a payload', async () => {
    let n = 0;
    const register = async ({ kind }) => ({ url: `asset://a-${kind}-${++n}`, assetId: `a-${kind}-${n}` });
    const payload = {
        model: 'm',
        content: [
            { type: 'text', text: 'hi' },
            { type: 'image_url', image_url: { url: 'https://tos.example/i.png' }, role: 'reference_image' },
            { type: 'video_url', video_url: { url: 'https://tos.example/v.mp4' }, role: 'reference_video' },
            { type: 'image_url', image_url: { url: 'asset://already' } },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } },
        ],
        duration: 4,
    };
    const out = await resolveSensitiveRefs(payload, register);
    assert.equal(out.content[0].text, 'hi');
    assert.equal(out.content[1].image_url.url, 'asset://a-image-1');
    assert.equal(out.content[1].role, 'reference_image'); // role preserved
    assert.equal(out.content[2].video_url.url, 'asset://a-video-2');
    assert.equal(out.content[3].image_url.url, 'asset://already'); // untouched
    assert.equal(out.content[4].image_url.url, 'data:image/png;base64,xx'); // untouched
    assert.equal(out.duration, 4);
    // input payload not mutated
    assert.equal(payload.content[1].image_url.url, 'https://tos.example/i.png');
});

test('asset calls retry through BytePlus QPS throttling, then succeed', async () => {
    const { getAsset } = await import('../lib/seedance/assetsClient.js');
    const responses = [
        { ok: false, status: 429, body: { error: 'RequestThrottled' } },
        { ok: true, status: 200, body: { ResponseMetadata: { Error: { Code: 'AccountFlowLimitExceeded', Message: 'request too frequent' } } } },
        { ok: true, status: 200, body: { Result: { Id: 'a1', Status: 'Active' } } },
    ];
    let calls = 0;
    const realFetch = global.fetch;
    global.fetch = async () => {
        const r = responses[Math.min(calls++, responses.length - 1)];
        return { ok: r.ok, status: r.status, json: async () => r.body };
    };
    try {
        const asset = await getAsset('a1'); // routes through callAsset's retry loop
        assert.equal(asset.id, 'a1');
        assert.equal(calls, 3); // 429 → throttle body → success
    } finally {
        global.fetch = realFetch;
    }
});

test('non-throttle asset errors still fail immediately', async () => {
    const { getAsset } = await import('../lib/seedance/assetsClient.js');
    let calls = 0;
    const realFetch = global.fetch;
    global.fetch = async () => { calls++; return { ok: false, status: 400, json: async () => ({ error: 'bad input' }) }; };
    try {
        await assert.rejects(() => getAsset('a1'), /bad input/);
        assert.equal(calls, 1);
    } finally {
        global.fetch = realFetch;
    }
});
