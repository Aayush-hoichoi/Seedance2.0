import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Bundle the real route, replacing only infrastructure and the encoder. This
// exercises its request/response contract without auth, a database or the CDN.
const stateKey = '__downloadDeliveryTest';
const stubs = {
    'next/server': 'export const NextResponse = { json: (body, init) => Response.json(body, init) };',
    'auth/user.js': 'export const getUser = async () => null;',
    'db/neon.js': 'export const getDb = async () => null;',
    'access/db.js': 'export const recordGenerationEvent = async () => {};',
    'seedance/ensureH264.mjs': `
        export const ensureH264 = async (buffer) => buffer;
        export const remuxToMov = async () => null;
        export const retimeToFps = async () => null;
        export const transcodeToProRes = async () => null;
        export const transcodeUrlToQuickTime = () => null;
        export const transcodeUrlToProRes = (url) => globalThis.${stateKey}.convert(url);
    `,
};
const bundled = await build({
    entryPoints: [fileURLToPath(new URL('../app/api/seedance/download/route.js', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [{
        name: 'download-route-infrastructure',
        setup(builder) {
            builder.onResolve({ filter: /.*/ }, ({ path }) => {
                const key = Object.keys(stubs).find((name) => path === name || path.endsWith(`/${name}`));
                return key ? { path: key, namespace: 'download-test' } : undefined;
            });
            builder.onLoad({ filter: /.*/, namespace: 'download-test' }, ({ path }) => ({ contents: stubs[path], loader: 'js' }));
        },
    }],
});
const { POST } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const sourceUrl = 'https://seedance-studio-assets.tos-ap-southeast-1.bytepluses.com/videos/task-123.mp4';
const encodedBytes = Buffer.from('streamed ProRes fixture');

function setup(t, { available = true, stream = Readable.from([encodedBytes]) } = {}) {
    const state = { sourceFetches: [], conversionUrls: [], cancellations: 0 };
    state.convert = (url) => {
        state.conversionUrls.push(url);
        if (!available) return null;
        return {
            stream,
            cancel() { state.cancellations += 1; stream.destroy(); },
        };
    };
    globalThis[stateKey] = state;
    t.mock.method(globalThis, 'fetch', async (url) => {
        state.sourceFetches.push(url);
        return new Response('original MP4 bytes', { headers: { 'Content-Type': 'video/mp4' } });
    });
    t.after(() => { stream.destroy(); delete globalThis[stateKey]; });
    return state;
}

function request(items = [{ url: sourceUrl, name: 'shot' }], signal, options = {}) {
    return new Request('http://localhost/api/seedance/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, format: 'prores', ...options }),
        signal,
    });
}

async function deliver(t, items, signal, options) {
    const response = await POST(request(items, signal, options));
    t.after(async () => {
        if (!response.bodyUsed) await response.body?.cancel().catch(() => {});
    });
    return response;
}

test('ProRes delivery streams a MOV without buffering the source file', async (t) => {
    const state = setup(t);
    const response = await deliver(t);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'video/quicktime');
    assert.match(response.headers.get('content-disposition'), /filename="shot\.mov"/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), encodedBytes);
    assert.deepEqual(state.conversionUrls, [sourceUrl]);
    assert.deepEqual(state.sourceFetches, [], 'the route must not buffer the source before streaming ProRes');
});

test('unavailable ProRes conversion returns an error instead of the original MP4', async (t) => {
    const state = setup(t, { available: false });
    const response = await deliver(t);

    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /ProRes/i);
    assert.deepEqual(state.sourceFetches, []);
});

test('aborting a ProRes download cancels its encoder', async (t) => {
    const state = setup(t, { stream: new PassThrough() });
    const controller = new AbortController();
    const response = await deliver(t, undefined, controller.signal);

    controller.abort();
    assert.equal(state.cancellations, 1);
    await response.body.cancel();
});

test('a failed encoder stream rejects the download instead of substituting MP4 bytes', async (t) => {
    const stream = new PassThrough();
    const state = setup(t, { stream });
    const response = await deliver(t);

    assert.equal(response.headers.get('content-type'), 'video/quicktime');
    await assert.rejects(async () => {
        const transfer = response.arrayBuffer();
        stream.write(encodedBytes);
        stream.destroy(new Error('ProRes encoder stopped.'));
        await transfer;
    }, /ProRes encoder stopped/);
    assert.deepEqual(state.sourceFetches, []);
});

test('raw original delivery bypasses the selected ProRes conversion', async (t) => {
    const state = setup(t);
    const response = await deliver(t, undefined, undefined, { raw: true });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.match(response.headers.get('content-disposition'), /filename="shot\.mp4"/);
    assert.equal(await response.text(), 'original MP4 bytes');
    assert.deepEqual(state.conversionUrls, []);
    assert.deepEqual(state.sourceFetches, [sourceUrl]);
});

test('an image cannot be downloaded as ProRes', async (t) => {
    const state = setup(t);
    const response = await deliver(t, [{ url: sourceUrl.replace('.mp4', '.png'), name: 'still' }]);

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /video/i);
    assert.deepEqual(state.conversionUrls, []);
    assert.deepEqual(state.sourceFetches, []);
});

test('bulk ProRes requests fail clearly instead of buffering multiple conversions', async (t) => {
    const state = setup(t);
    const response = await deliver(t, [
        { url: sourceUrl, name: 'first' },
        { url: sourceUrl, name: 'second' },
    ]);

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /one.*(?:time|video)|single/i);
    assert.deepEqual(state.conversionUrls, []);
    assert.deepEqual(state.sourceFetches, []);
});
