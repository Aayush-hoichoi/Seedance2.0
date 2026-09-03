import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMediaRefs, resolveVideoRefs, createWithQuotaRecovery, uploadGroupName } from '../lib/seedance/assetsClient.js';

// Per-project hard partition: each project routes assets into its own group,
// keyed by project id so a rename can't merge two projects' libraries.
test('uploadGroupName gives each project its own id-keyed group, legacy fallback without one', () => {
    assert.equal(uploadGroupName(null), 'Seedance Studio');
    assert.equal(uploadGroupName({ id: 7, name: 'Marketing' }), 'Seedance Studio · Marketing #7');
    // Same id, renamed project → still ends with the stable "#<id>" suffix.
    assert.ok(uploadGroupName({ id: 7, name: 'Ads' }).endsWith(' #7'));
    // Different projects never collide.
    assert.notEqual(uploadGroupName({ id: 7, name: 'A' }), uploadGroupName({ id: 8, name: 'A' }));
});

const fakeRegister = async ({ url }) => ({ url: 'asset://asset-test-1', assetId: 'asset-test-1', from: url });
// Distinct id per call — for asserting which items were newly registered.
const countingRegister = () => {
    let n = 0;
    return async ({ url, kind }) => { const id = `asset-${kind}-${++n}`; return { url: `asset://${id}`, assetId: id, from: url }; };
};

test('swaps raw image AND video URLs for asset:// refs (real-person scan needs both verified)', async () => {
    const items = [
        { kind: 'video', url: 'https://tos.example/v.mp4', role: 'reference_video', tosKey: 'uploads/v.mp4' },
        { kind: 'image', url: 'https://tos.example/i.png', role: 'reference_image', tosKey: 'uploads/i.png' },
    ];
    const out = await resolveMediaRefs(items, countingRegister());
    assert.equal(out[0].url, 'asset://asset-video-1');
    assert.equal(out[1].url, 'asset://asset-image-2');
    assert.equal(out[0].tosKey, 'uploads/v.mp4'); // tosKey preserved for Reuse/thumbnails
    assert.equal(out[1].role, 'reference_image'); // role preserved
});

test('resolveVideoRefs is a back-compat alias of resolveMediaRefs', () => {
    assert.equal(resolveVideoRefs, resolveMediaRefs);
});

test('leaves audio, data: images and existing asset:// refs untouched', async () => {
    const items = [
        { kind: 'audio', url: 'https://tos.example/a.mp3' },       // audio is never real-person-scanned
        { kind: 'image', url: 'data:image/png;base64,xx' },        // inline image can't be registered by URL
        { kind: 'video', url: 'asset://asset-already' },           // already resolved
        { kind: 'image', url: 'asset://img-already' },             // already resolved
    ];
    const out = await resolveMediaRefs(items, async () => { throw new Error('must not be called'); });
    assert.deepEqual(out, items);
});

test('does not mutate the input items', async () => {
    const item = { kind: 'image', url: 'https://tos.example/i.png' };
    await resolveMediaRefs([item], fakeRegister);
    assert.equal(item.url, 'https://tos.example/i.png');
});

// CreateAsset shares a 120 QPM zero-burst account-wide write quota (429
// QuotaWriteQPMExceeded on any parallel burst). A ref registered in an
// earlier submit must be reused via a cheap GetAsset read, never re-created.
test('a ref registered in an earlier submit is reused, not re-registered', async () => {
    let creates = 0;
    const register = async ({ kind }) => { creates++; return { url: `asset://reuse-${kind}`, assetId: `reuse-${kind}` }; };
    const verified = [];
    const verify = async (id) => { verified.push(id); return { id, status: 'Active' }; };
    await resolveMediaRefs([{ kind: 'image', url: 'https://tos.example/reuse-me.png?sig=1' }], register, verify);
    // Second submit, same file, different presign query → cache hit, read-only.
    const out = await resolveMediaRefs([{ kind: 'image', url: 'https://tos.example/reuse-me.png?sig=2' }], register, verify);
    assert.equal(creates, 1);
    assert.deepEqual(verified, ['reuse-image']);
    assert.equal(out[0].url, 'asset://reuse-image');
    assert.equal(out[0].assetId, 'reuse-image');
});

test('a cached ref whose asset was swept re-registers instead of failing', async () => {
    let creates = 0;
    const register = async () => { creates++; return { url: `asset://swept-${creates}`, assetId: `swept-${creates}` }; };
    const items = [{ kind: 'image', url: 'https://tos.example/swept.png' }];
    await resolveMediaRefs(items, register, async () => { throw new Error('must not verify a fresh registration'); });
    // The 1h sweep (or another user) deleted the asset since → verify says gone.
    const out = await resolveMediaRefs(items, register, async () => { throw new Error('not found'); });
    assert.equal(creates, 2);
    assert.equal(out[0].url, 'asset://swept-2');
});

test('a failed registration is not cached — the next submit tries again', async () => {
    let attempt = 0;
    const items = [{ kind: 'image', url: 'https://tos.example/flaky.png' }];
    await assert.rejects(
        () => resolveMediaRefs(items, async () => { attempt++; throw new Error('rate limit'); }),
        /rate limit/,
    );
    const out = await resolveMediaRefs(items, async () => { attempt++; return { url: 'asset://flaky-ok', assetId: 'flaky-ok' }; });
    assert.equal(attempt, 2);
    assert.equal(out[0].url, 'asset://flaky-ok');
});

test('propagates registration failures', async () => {
    const items = [{ kind: 'video', url: 'https://tos.example/v.mp4' }];
    await assert.rejects(
        () => resolveMediaRefs(items, async () => { throw new Error('quota'); }),
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

test('resolveMediaRefs registers an identical source URL only once per submit', async () => {
    let calls = 0;
    const register = async ({ url, kind }) => { calls++; return { url: `asset://${kind}-1`, assetId: `${kind}-1`, from: url }; };
    // Same underlying file in two slots (different presign query strings).
    const items = [
        { kind: 'image', url: 'https://tos.example/face.png?sig=a', role: 'reference_image' },
        { kind: 'image', url: 'https://tos.example/face.png?sig=b', role: 'first_frame' },
    ];
    const out = await resolveMediaRefs(items, register);
    assert.equal(calls, 1); // de-duped — one registration, not two
    assert.equal(out[0].url, 'asset://image-1');
    assert.equal(out[1].url, 'asset://image-1'); // both slots point at the same verified asset
    assert.equal(out[1].role, 'first_frame');    // per-item role preserved
});

test('cleanupOldAssets sweeps stale assets across ALL studio groups, never foreign groups', async () => {
    const { cleanupOldAssets } = await import('../lib/seedance/assetsClient.js');
    const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const fresh = new Date().toISOString();
    const assetsByGroup = {
        g1: [{ Id: 'a1', CreateTime: old, AssetType: 'Video' }, { Id: 'a2', CreateTime: fresh, AssetType: 'Image' }],
        g2: [{ Id: 'a3', CreateTime: old, AssetType: 'Image' }],
        g3: [{ Id: 'foreign', CreateTime: old, AssetType: 'Image' }],
    };
    const deleted = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => {
        const { action, payload } = JSON.parse(opts.body);
        let body = {};
        if (action === 'ListAssetGroups') body = { Result: { Items: [
            { Id: 'g1', Name: 'Seedance Studio · A #1' },
            { Id: 'g2', Name: 'Seedance Studio · B #2' },
            { Id: 'g3', Name: 'My personal library' },
        ] } };
        else if (action === 'ListAssets') body = { Result: { Items: assetsByGroup[payload.Filter.GroupIds[0]] || [] } };
        else if (action === 'DeleteAsset') { deleted.push(payload.Id); body = { Result: {} }; }
        return { ok: true, status: 200, json: async () => body };
    };
    try {
        const freed = await cleanupOldAssets({ maxAgeHours: 24 });
        assert.equal(freed, 2);
        // Stale assets from BOTH studio groups go; the fresh one and the
        // user's own (non-studio) library are untouched.
        assert.deepEqual(deleted.sort(), ['a1', 'a3']);
    } finally {
        global.fetch = realFetch;
    }
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

// --- Sensitive Content raw-URL fallback ----------------------------------------
//
// On the Sensitive Content endpoint the studio wraps register: a clip the
// Library's sensitive scan rejects resolves to { url: raw, assetId: null }
// instead of throwing. Two contracts matter here: the item keeps its raw URL
// (the endpoint's own moderation takes over), and a LATER submit reuses the
// cached fallback verdict instead of re-paying the ~30s failing scan.

test('an assetId-less register result keeps the raw URL and is reused without re-registering', async () => {
    let calls = 0;
    const fallbackRegister = async ({ url }) => { calls += 1; return { url, assetId: null }; };
    const item = { kind: 'video', url: 'https://tos.example/gory.mp4?sig=1', role: 'reference_video' };

    const [first] = await resolveMediaRefs([item], fallbackRegister);
    assert.equal(first.url, item.url, 'the raw URL must survive to the payload');
    assert.equal(calls, 1);

    // Same clip, re-presigned (query differs) — cache keys on kind+url minus query.
    const verify = async () => { throw new Error('must not verify: there is no asset'); };
    const [again] = await resolveMediaRefs([{ ...item, url: 'https://tos.example/gory.mp4?sig=2' }], fallbackRegister, verify);
    assert.equal(again.url, 'https://tos.example/gory.mp4?sig=2');
    assert.equal(calls, 1, 'the cached fallback must not trigger a second registration');
});
