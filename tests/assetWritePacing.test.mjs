import test from 'node:test';
import assert from 'node:assert/strict';

// The account-wide asset WRITE quota (120 QPM, zero burst) is ~2 calls/second.
// Serializing the writes only stopped parallel bursts — a chain with no gap
// still fires at round-trip speed, which is how a background sweep could hold
// the quota long enough to fail the upload that triggered it. These cover the
// two brakes: a floor gap between writes, and a per-run delete cap.
process.env.ARK_AK = 'test-ak';
process.env.ARK_SK = 'test-sk';
process.env.ARK_WRITE_GAP_MS = '80';
const GAP = 80;

const { callAsset, cleanupOldAssets } = await import('../lib/byteplus/assetsServer.js');
const { UPLOAD_GROUP_NAME } = await import('../lib/seedance/assetGroupName.mjs');

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test('queued writes are spaced, never fired back to back', async () => {
    const realFetch = global.fetch;
    const at = [];
    global.fetch = async () => { at.push(Date.now()); return ok({ Result: {} }); };
    try {
        const start = Date.now();
        await Promise.all([1, 2, 3].map((i) => callAsset('DeleteAsset', { Id: `a${i}` })));
        assert.equal(at.length, 3);
        assert.ok(Date.now() - start >= GAP * 2, 'three writes must span at least two gaps');
        for (let i = 1; i < at.length; i++) {
            assert.ok(at[i] - at[i - 1] >= GAP, `write ${i} came ${at[i] - at[i - 1]}ms after the last`);
        }
    } finally {
        global.fetch = realFetch;
    }
});

test('a sweep deletes at most maxDeletes per run, leaving the rest to age out', async () => {
    const realFetch = global.fetch;
    let deletes = 0;
    const stale = Array.from({ length: 10 }, (_, i) => ({
        Id: `a${i}`, AssetType: 'Image', Status: 'Active', CreateTime: '2020-01-01T00:00:00Z',
    }));
    global.fetch = async (url) => {
        if (String(url).includes('Action=ListAssetGroups')) {
            return ok({ Result: { Items: [{ Id: 'g1', Name: `${UPLOAD_GROUP_NAME} · demo #1` }] } });
        }
        if (String(url).includes('Action=ListAssets')) return ok({ Result: { Items: stale } });
        deletes++;
        return ok({ Result: {} });
    };
    try {
        assert.equal(await cleanupOldAssets({ maxDeletes: 3 }), 3);
        assert.equal(deletes, 3);
    } finally {
        global.fetch = realFetch;
    }
});
