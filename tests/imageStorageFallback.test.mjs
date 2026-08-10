import test from 'node:test';
import assert from 'node:assert/strict';

// storeImages falls back to inline base64 so a paid-for generation is never
// lost. That is correct — but the fallback used to be indistinguishable from
// success, so when the TOS access key was rotated in Aug 2026 every image
// quietly went into Postgres as megabytes of base64 for two days. Nothing
// logged, nothing alerted, and the job rows still looked settled.
//
// These tests pin the distinction the fix introduces: a MISSING credential is
// the documented dev path and stays quiet; a credential that TOS REFUSES is an
// incident and must be logged. Both still return the image.

const ENV = ['ARK_AK', 'ARK_SK', 'TOS_BUCKET'];

// storage.mjs reads TOS_BUCKET at module load, so each case needs its own copy.
async function loadWith(vars, fn) {
    const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    const savedFetch = globalThis.fetch;
    const savedError = console.error;
    const logs = [];
    console.error = (...args) => logs.push(args.join(' '));
    Object.assign(process.env, vars.env);
    globalThis.fetch = vars.fetch ?? (() => Promise.resolve({ ok: true }));
    try {
        const mod = await import(`../lib/gateway/storage.mjs?c=${encodeURIComponent(JSON.stringify(vars.env))}`);
        return await fn(mod, logs);
    } finally {
        console.error = savedError;
        globalThis.fetch = savedFetch;
        for (const k of ENV) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
    }
}

const CREDS = { ARK_AK: `AKAP${'a'.repeat(43)}`, ARK_SK: 'b'.repeat(60), TOS_BUCKET: 'test-bucket' };
const IMAGE = [{ b64: Buffer.from('hello').toString('base64'), mimeType: 'image/png' }];

test('a successful upload stores a key and logs nothing', async () => {
    await loadWith({ env: CREDS }, async (mod, logs) => {
        const [out] = await mod.storeImages(77, IMAGE);
        assert.equal(out.key, 'images/job-77-0.png');
        assert.equal(out.b64, undefined, 'a stored image must not also carry base64');
        assert.deepEqual(logs, []);
    });
});

test('a TOS rejection is logged and still returns the image', async () => {
    const fetchStub = () => Promise.resolve({
        ok: false, status: 403, text: () => Promise.resolve('<Error><Code>AccessDenied</Code></Error>'),
    });
    await loadWith({ env: CREDS, fetch: fetchStub }, async (mod, logs) => {
        const [out] = await mod.storeImages(88, IMAGE);
        assert.equal(out.b64, IMAGE[0].b64, 'the generation must survive the failure');
        assert.equal(out.key, undefined);

        assert.equal(logs.length, 1, 'a refused upload must not be silent');
        // The log has to carry enough to act on without reproducing it.
        assert.match(logs[0], /job 88/, 'must identify the job');
        assert.match(logs[0], /403/, 'must carry the status');
        assert.match(logs[0], /test-bucket/, 'must name the bucket, the usual misconfiguration');
        assert.match(logs[0], /AccessDenied/, "must include the provider's reason");
    });
});

test('a thrown upload is logged and still returns the image', async () => {
    const fetchStub = () => Promise.reject(new Error('socket hang up'));
    await loadWith({ env: CREDS, fetch: fetchStub }, async (mod, logs) => {
        const [out] = await mod.storeImages(99, IMAGE);
        assert.equal(out.b64, IMAGE[0].b64);
        assert.equal(logs.length, 1, 'a thrown upload must not be silent');
        assert.match(logs[0], /socket hang up/);
        assert.match(logs[0], /job 99/);
    });
});

test('absent credentials stay quiet — that is the documented dev path', async () => {
    await loadWith({ env: { ARK_AK: '', ARK_SK: '', TOS_BUCKET: 'test-bucket' } }, async (mod, logs) => {
        const [out] = await mod.storeImages(1, IMAGE);
        assert.equal(out.b64, IMAGE[0].b64);
        assert.deepEqual(logs, [], 'running without TOS locally is not an incident');
    });
});

test('every image in a batch is reported, not just the first', async () => {
    let n = 0;
    const fetchStub = () => {
        n += 1;
        return Promise.resolve(n === 2
            ? { ok: true }
            : { ok: false, status: 500, text: () => Promise.resolve('boom') });
    };
    await loadWith({ env: CREDS, fetch: fetchStub }, async (mod, logs) => {
        const out = await mod.storeImages(5, [IMAGE[0], IMAGE[0], IMAGE[0]]);
        assert.deepEqual(out.map((o) => !!o.key), [false, true, false]);
        assert.equal(logs.length, 2, 'each failed image needs its own line');
        assert.match(logs[0], /image 0/);
        assert.match(logs[1], /image 2/);
    });
});

test('a provider that returned a URL instead of base64 is passed through untouched', async () => {
    await loadWith({ env: CREDS }, async (mod, logs) => {
        const [out] = await mod.storeImages(2, [{ url: 'https://example.test/a.png' }]);
        assert.deepEqual(out, { url: 'https://example.test/a.png' });
        assert.deepEqual(logs, [], 'nothing was uploaded, so there is nothing to report');
    });
});
