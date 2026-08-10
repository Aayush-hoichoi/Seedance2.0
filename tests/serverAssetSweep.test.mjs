import test from 'node:test';
import assert from 'node:assert/strict';

// Reference assets are deliberately NOT deleted when a batch finishes — they
// are reused across submits to keep bursts off the 120 QPM write quota — so age
// sweeping is the ONLY thing that returns capacity to the small account-wide
// pool. Until now that sweep lived exclusively in the studio client, running on
// mount and every 30 minutes *while a tab stayed open*. With no tab open
// nothing collected anything, and assets registered through MCP register_asset
// were never swept at all. The first symptom was always somebody's upload
// failing on a pool nobody could see.
//
// These cover the server-side twin: what it deletes, what it must never touch,
// and the throttle that keeps it from spending the very quota it protects.

// assetsServer talks to BytePlus through callAsset -> fetch, so a fetch stub is
// the whole seam. Responses mimic the Result/Items shape the real API returns.
function stubBytePlus({ groups, assetsByGroup }) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        const action = new URL(url).searchParams.get('Action');
        const payload = JSON.parse(init.body || '{}');
        calls.push({ action, payload });
        if (action === 'ListAssetGroups') {
            return json({ Result: { Items: groups.map((g) => ({ Id: g.id, Name: g.name, CreateTime: '2026-01-01T00:00:00Z' })) } });
        }
        if (action === 'ListAssets') {
            const id = payload.Filter.GroupIds[0];
            return json({ Result: { Items: (assetsByGroup[id] || []).map((a) => ({
                Id: a.id, AssetType: 'Image', Status: 'Active', GroupId: id, CreateTime: a.createdAt,
            })) } });
        }
        if (action === 'DeleteAsset') return json({ Result: {} });
        return json({ Result: {} });
    };
    return calls;
}

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

// callAsset refuses to sign without credentials, so the fetch stub is only
// reachable with these set. The values never leave the process — every request
// is intercepted before it goes anywhere.
let savedFetch;
let savedEnv;
test.beforeEach(() => {
    savedFetch = globalThis.fetch;
    savedEnv = { ak: process.env.ARK_AK, sk: process.env.ARK_SK };
    process.env.ARK_AK = `AKAP${'a'.repeat(43)}`;
    process.env.ARK_SK = 'b'.repeat(60);
});
test.afterEach(() => {
    globalThis.fetch = savedFetch;
    for (const [key, value] of [['ARK_AK', savedEnv.ak], ['ARK_SK', savedEnv.sk]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

const GROUPS = [
    { id: 'g-studio-a', name: 'Seedance Studio · Alpha #1' },
    { id: 'g-studio-b', name: 'Seedance Studio · Beta #2' },
    { id: 'g-user', name: 'My Own Characters' }, // the user's library
];

test('stale assets are swept across every studio group, not just one', async () => {
    const { cleanupOldAssets } = await import('../lib/byteplus/assetsServer.js');
    const calls = stubBytePlus({
        groups: GROUPS,
        assetsByGroup: {
            'g-studio-a': [{ id: 'a-old', createdAt: hoursAgo(3) }],
            'g-studio-b': [{ id: 'b-old', createdAt: hoursAgo(2) }],
        },
    });
    assert.equal(await cleanupOldAssets({ maxAgeHours: 1 }), 2,
        'assets parked in another project group count against the same pool');
    const deleted = calls.filter((c) => c.action === 'DeleteAsset').map((c) => c.payload.Id);
    assert.deepEqual(deleted.sort(), ['a-old', 'b-old']);
});

test('assets inside the retention window are left alone', async () => {
    const { cleanupOldAssets } = await import('../lib/byteplus/assetsServer.js');
    const calls = stubBytePlus({
        groups: GROUPS,
        assetsByGroup: { 'g-studio-a': [{ id: 'fresh', createdAt: hoursAgo(0.25) }] },
    });
    assert.equal(await cleanupOldAssets({ maxAgeHours: 1 }), 0, 'a render in flight still needs these');
    assert.equal(calls.filter((c) => c.action === 'DeleteAsset').length, 0);
});

test("the user's own library is never touched", async () => {
    const { cleanupOldAssets } = await import('../lib/byteplus/assetsServer.js');
    const calls = stubBytePlus({
        groups: GROUPS,
        assetsByGroup: { 'g-user': [{ id: 'precious', createdAt: hoursAgo(500) }] },
    });
    assert.equal(await cleanupOldAssets({ maxAgeHours: 1 }), 0);
    assert.equal(calls.filter((c) => c.action === 'DeleteAsset').length, 0,
        'groups the studio did not create are the user’s, however old');
    assert.equal(calls.filter((c) => c.action === 'ListAssets').length, 2,
        'the user group should not even be listed');
});

test('the throttle allows one sweep per window and suppresses the rest', async () => {
    const { sweepAssetsIfDue, resetAssetSweepThrottle } = await import('../lib/byteplus/assetsServer.js');
    resetAssetSweepThrottle();
    const calls = stubBytePlus({
        groups: GROUPS,
        assetsByGroup: { 'g-studio-a': [{ id: 'a-old', createdAt: hoursAgo(3) }] },
    });
    const t0 = Date.now();
    assert.equal(await sweepAssetsIfDue({ now: t0 }), 1, 'first call sweeps');
    assert.equal(sweepAssetsIfDue({ now: t0 + 60_000 }), null, 'a minute later is suppressed');
    assert.equal(sweepAssetsIfDue({ now: t0 + 9 * 60_000 }), null, 'still inside the window');
    assert.equal(await sweepAssetsIfDue({ now: t0 + 11 * 60_000 }), 1, 'past the window it sweeps again');

    assert.equal(calls.filter((c) => c.action === 'ListAssetGroups').length, 2,
        'suppressed calls must not reach BytePlus at all — that quota is what we are protecting');
});

test('a sweep failure resolves rather than rejecting, so it cannot fail a registration', async () => {
    const { sweepAssetsIfDue, resetAssetSweepThrottle } = await import('../lib/byteplus/assetsServer.js');
    resetAssetSweepThrottle();
    globalThis.fetch = async () => { throw new Error('BytePlus unreachable'); };
    assert.equal(await sweepAssetsIfDue({ now: Date.now() }), 0,
        'the upload that triggered this already succeeded; the sweep must stay silent');
});

test('one undeletable asset does not abort the rest of the sweep', async () => {
    const { cleanupOldAssets } = await import('../lib/byteplus/assetsServer.js');
    stubBytePlus({
        groups: GROUPS,
        assetsByGroup: {
            'g-studio-a': [{ id: 'gone', createdAt: hoursAgo(3) }, { id: 'ok', createdAt: hoursAgo(3) }],
        },
    });
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const payload = JSON.parse(init.body || '{}');
        if (new URL(url).searchParams.get('Action') === 'DeleteAsset' && payload.Id === 'gone') {
            return new Response(JSON.stringify({ ResponseMetadata: { Error: { Message: 'asset not found' } } }), { status: 404 });
        }
        return inner(url, init);
    };
    assert.equal(await cleanupOldAssets({ maxAgeHours: 1 }), 1,
        'a already-deleted id is normal under concurrent sweeps — keep going');
});
