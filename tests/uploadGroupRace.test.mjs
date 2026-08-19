import test from 'node:test';
import assert from 'node:assert/strict';

// resolveMediaRefs registers every reference with Promise.all, so attaching four
// references put four callers into ensureUploadGroup before any had filled the
// cache. All four saw "no group" and all four created one — production ended up
// with 7x "Seedance Studio · TURTLE #19", 6x Hooliganism, 4x Dream Bris Vegas.
//
// The cost is not just clutter: each duplicate is a CreateAssetGroup WRITE, on
// top of the CreateAsset writes, in one burst against an account-wide 120 QPM
// quota with NO burst tolerance. That is exactly the "provider is rate-limiting
// new reference registrations" error users hit on a 4-reference submit.
//
// The fix caches the in-flight PROMISE, so concurrent callers share one lookup.

async function loadServer(fetchImpl) {
    const saved = { fetch: globalThis.fetch, ak: process.env.ARK_AK, sk: process.env.ARK_SK };
    globalThis.fetch = fetchImpl;
    process.env.ARK_AK = `AKAP${'a'.repeat(43)}`;
    process.env.ARK_SK = 'b'.repeat(60);
    // Fresh module each time: uploadGroupCache is module state.
    const mod = await import(`../lib/byteplus/assetsServer.js?race=${Math.random()}`);
    return { mod, restore: () => {
        globalThis.fetch = saved.fetch;
        if (saved.ak === undefined) delete process.env.ARK_AK; else process.env.ARK_AK = saved.ak;
        if (saved.sk === undefined) delete process.env.ARK_SK; else process.env.ARK_SK = saved.sk;
    } };
}

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('four concurrent callers create ONE group, not four', async () => {
    const calls = [];
    const { mod, restore } = await loadServer(async (url, init) => {
        const action = new URL(url).searchParams.get('Action');
        calls.push(action);
        if (action === 'ListAssetGroups') {
            // Slow list: widens the window every racing caller used to slip through.
            await new Promise((r) => setTimeout(r, 20));
            return json({ Result: { Items: [] } });
        }
        if (action === 'CreateAssetGroup') return json({ Result: { Id: 'group-created-once' } });
        return json({ Result: {} });
    });
    try {
        const project = { id: 19, name: 'TURTLE' };
        const ids = await Promise.all([1, 2, 3, 4].map(() => mod.ensureUploadGroup(project)));

        assert.deepEqual(ids, Array(4).fill('group-created-once'), 'every caller gets the same group');
        const creates = calls.filter((a) => a === 'CreateAssetGroup').length;
        assert.equal(creates, 1, `expected exactly one CreateAssetGroup write, saw ${creates}`);
        const lists = calls.filter((a) => a === 'ListAssetGroups').length;
        assert.equal(lists, 1, 'and one lookup, not four');
    } finally { restore(); }
});

test('an existing group is adopted without any write at all', async () => {
    const calls = [];
    const { mod, restore } = await loadServer(async (url) => {
        const action = new URL(url).searchParams.get('Action');
        calls.push(action);
        if (action === 'ListAssetGroups') {
            return json({ Result: { Items: [{ Id: 'group-existing', Name: 'Seedance Studio · TURTLE #19' }] } });
        }
        return json({ Result: {} });
    });
    try {
        const ids = await Promise.all([1, 2, 3].map(() => mod.ensureUploadGroup({ id: 19, name: 'TURTLE' })));
        assert.deepEqual(ids, Array(3).fill('group-existing'));
        assert.equal(calls.filter((a) => a === 'CreateAssetGroup').length, 0,
            'adopting a group must cost no write quota');
    } finally { restore(); }
});

test('a failed lookup is evicted, so one bad submit does not poison the next', async () => {
    let attempt = 0;
    const { mod, restore } = await loadServer(async (url) => {
        const action = new URL(url).searchParams.get('Action');
        if (action === 'ListAssetGroups') {
            attempt += 1;
            if (attempt === 1) return new Response('{}', { status: 500 });
            return json({ Result: { Items: [{ Id: 'group-later', Name: 'Seedance Studio · TURTLE #19' }] } });
        }
        return json({ Result: {} });
    });
    try {
        const project = { id: 19, name: 'TURTLE' };
        await assert.rejects(() => mod.ensureUploadGroup(project), 'the first attempt fails');
        // A cached REJECTED promise would make this fail forever.
        assert.equal(await mod.ensureUploadGroup(project), 'group-later',
            'the retry must re-run the lookup, not replay the failure');
    } finally { restore(); }
});
