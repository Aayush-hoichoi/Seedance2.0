import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPromptRecords } from '../lib/seedance/promptsClient.js';

// The prompts API answers at most 100 ids per request. Ids past the cap used
// to come back "unknown", and the history purge dropped them as foreign.
function fakeFetch({ failOn = -1 } = {}) {
    const calls = [];
    globalThis.fetch = async (url) => {
        const ids = decodeURIComponent(url.split('taskIds=')[1]).split(',');
        calls.push(ids.length);
        if (calls.length - 1 === failOn) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ items: ids.map((task_id) => ({ task_id })) }) };
    };
    return calls;
}

const ids = Array.from({ length: 250 }, (_, i) => `cgt-${i}`);

test('fetchPromptRecords chunks past the 100-id server cap', async () => {
    const calls = fakeFetch();
    const byTask = await fetchPromptRecords(ids);
    assert.deepEqual(calls, [100, 100, 50]);
    assert.equal(Object.keys(byTask).length, 250);
});

test('strict mode returns null if any chunk fails; default mode keeps best-effort {}', async () => {
    fakeFetch({ failOn: 1 });
    assert.equal(await fetchPromptRecords(ids, { strict: true }), null);
    fakeFetch({ failOn: 1 });
    assert.deepEqual(await fetchPromptRecords(ids), {});
});
