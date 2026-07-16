import test from 'node:test';
import assert from 'node:assert/strict';

// Mirrors tests/resolveVideoRefs.test.mjs's client-side QPS-throttle retry
// tests, against the server-side callAsset ported in lib/byteplus/assetsServer.js
// (Task 8 review follow-up: register_asset's pollAssetActive raises server call
// volume, so the same backoff needs to apply here too).

test('server callAsset retries through BytePlus QPS throttling, then succeeds', async () => {
    const prevAk = process.env.ARK_AK;
    const prevSk = process.env.ARK_SK;
    process.env.ARK_AK = 'test-ak';
    process.env.ARK_SK = 'test-sk';
    const { callAsset } = await import('../lib/byteplus/assetsServer.js');
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
        const data = await callAsset('GetAsset', { Id: 'a1' });
        assert.equal(data.Result.Id, 'a1');
        assert.equal(calls, 3); // 429 → throttle body → success
    } finally {
        global.fetch = realFetch;
        process.env.ARK_AK = prevAk;
        process.env.ARK_SK = prevSk;
    }
});

test('server callAsset: non-throttle errors still fail immediately', async () => {
    const prevAk = process.env.ARK_AK;
    const prevSk = process.env.ARK_SK;
    process.env.ARK_AK = 'test-ak';
    process.env.ARK_SK = 'test-sk';
    const { callAsset } = await import('../lib/byteplus/assetsServer.js');
    let calls = 0;
    const realFetch = global.fetch;
    global.fetch = async () => { calls++; return { ok: false, status: 400, json: async () => ({ error: 'bad input' }) }; };
    try {
        await assert.rejects(() => callAsset('GetAsset', { Id: 'a1' }), /Asset API GetAsset failed \(400\)/);
        assert.equal(calls, 1);
    } finally {
        global.fetch = realFetch;
        process.env.ARK_AK = prevAk;
        process.env.ARK_SK = prevSk;
    }
});

test('pollAssetActive rejects with STILL_PROCESSING once an expired deadline is hit, without polling', async () => {
    const prevAk = process.env.ARK_AK;
    const prevSk = process.env.ARK_SK;
    process.env.ARK_AK = 'test-ak';
    process.env.ARK_SK = 'test-sk';
    const { pollAssetActive } = await import('../lib/byteplus/assetsServer.js');
    let calls = 0;
    const realFetch = global.fetch;
    global.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ Result: { Id: 'a1', Status: 'Processing' } }) }; };
    try {
        await assert.rejects(
            () => pollAssetActive('a1', { deadlineMs: Date.now() - 1 }),
            (err) => err.code === 'STILL_PROCESSING',
        );
        assert.equal(calls, 0); // deadline check happens before the getAsset fetch
    } finally {
        global.fetch = realFetch;
        process.env.ARK_AK = prevAk;
        process.env.ARK_SK = prevSk;
    }
});
