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
        export const ensureH264 = async (buffer) => globalThis.${stateKey}.ensure(buffer);
        export const remuxToMov = async () => null;
        export const retimeToFps = async () => null;
        export const transcodeToProRes = async () => null;
        export const transcodeUrlToQuickTime = (url) => globalThis.${stateKey}.convert(url);
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
    const state = { sourceFetches: [], conversionUrls: [], cancellations: 0, ensure: async (buffer) => buffer };
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
    await assert.rejects(response.arrayBuffer(), /abort/i);
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

function configureVideoCdn(t) {
    const previous = process.env.VIDEO_CDN_DOMAIN;
    process.env.VIDEO_CDN_DOMAIN = 'video-cdn.example.com';
    t.after(() => {
        if (previous === undefined) delete process.env.VIDEO_CDN_DOMAIN;
        else process.env.VIDEO_CDN_DOMAIN = previous;
    });
}

for (const options of [{ raw: true }, { format: 'mp4' }, { format: 'mov' }, { format: 'prores' }]) {
    test(`configured video CDN remains a download source for ${options.raw ? 'original' : options.format}`, async (t) => {
        configureVideoCdn(t);
        const state = setup(t);
        const url = 'https://video-cdn.example.com/videos/task-123.mp4?Expires=1800000000&Signature=test&Key-Pair-Id=test';
        const response = await deliver(t, [{ url, name: 'shot' }], undefined, options);
        assert.equal(response.status, 200);
        if (options.format === 'prores') {
            assert.deepEqual(state.conversionUrls, [url], 'encoder should stream through the CDN');
            assert.deepEqual(state.sourceFetches, []);
            assert.equal(response.headers.get('content-type'), 'video/quicktime');
            assert.deepEqual(Buffer.from(await response.arrayBuffer()), encodedBytes);
        } else {
            assert.deepEqual(state.sourceFetches, [url], 'download should retain the CDN cache benefit');
            assert.deepEqual(state.conversionUrls, []);
            assert.equal(await response.text(), 'original MP4 bytes');
        }
    });
}

test('download rejects foreign CDN distributions and non-video CDN paths', async (t) => {
    configureVideoCdn(t);
    const state = setup(t);
    for (const url of [
        'https://other.cloudfront.net/videos/task.mp4',
        'https://video-cdn.example.com.evil.example/videos/task.mp4',
        'http://video-cdn.example.com/videos/task.mp4',
        'https://user:password@video-cdn.example.com/videos/task.mp4',
        'https://video-cdn.example.com:8443/videos/task.mp4',
        'https://video-cdn.example.com/uploads/reference.mp4',
        'https://video-cdn.example.com/images/still.png',
        'https://video-cdn.example.com/exr/output.mov',
    ]) {
        const response = await deliver(t, [{ url, name: 'shot' }], undefined, { raw: true });
        assert.equal(response.status, 400, url);
    }
    assert.deepEqual(state.sourceFetches, []);
    assert.deepEqual(state.conversionUrls, []);
});

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

async function expectBusy(options = {}) {
    const response = await POST(request(undefined, undefined, options));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '5');
    assert.match((await response.json()).error, /another video.*retry/i);
}

function nextConversion(state) {
    state.convert = (url) => {
        state.conversionUrls.push(url);
        return { stream: Readable.from([encodedBytes]), cancel() {} };
    };
}

for (const format of ['prores', 'quicktime']) {
    test(`${format} admits one conversion and releases it after completion`, async (t) => {
        const stream = new PassThrough();
        const state = setup(t, { stream });
        const first = await deliver(t, undefined, undefined, { format });
        await expectBusy({ format });
        assert.equal(state.conversionUrls.length, 1, 'the busy request must not spawn another encoder');
        stream.end(encodedBytes);
        await first.arrayBuffer();
        nextConversion(state);
        const next = await deliver(t, undefined, undefined, { format });
        assert.equal(next.status, 200);
        await next.arrayBuffer();
    });
}

test('stream cancellation holds the slot until the encoder actually exits', async (t) => {
    const stream = new PassThrough();
    const state = setup(t, { stream });
    const exited = deferred();
    const convert = state.convert;
    state.convert = (url) => ({ ...convert(url), done: exited.promise });
    const first = await deliver(t);
    const canceled = first.body.cancel();
    await expectBusy();
    exited.resolve();
    await canceled;
    nextConversion(state);
    const next = await deliver(t);
    assert.equal(next.status, 200);
    await next.arrayBuffer();
});

test('stream failure releases the slot after encoder exit', async (t) => {
    const stream = new PassThrough();
    const state = setup(t, { stream });
    const exited = deferred();
    const convert = state.convert;
    state.convert = (url) => ({ ...convert(url), done: exited.promise });
    const first = await deliver(t);
    const transfer = first.arrayBuffer();
    stream.destroy(new Error('encoder failed'));
    await assert.rejects(transfer, /encoder failed/);
    await expectBusy();
    exited.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    nextConversion(state);
    const next = await deliver(t);
    assert.equal(next.status, 200);
    await next.arrayBuffer();
});

test('buffered conversion acquires before the source fetch and holds through body consumption', async (t) => {
    const state = setup(t);
    const started = deferred();
    const source = deferred();
    t.mock.method(globalThis, 'fetch', async (url) => {
        state.sourceFetches.push(url);
        started.resolve();
        await source.promise;
        return new Response('source bytes');
    });
    const pending = deliver(t, undefined, undefined, { format: 'mp4' });
    await started.promise;
    await expectBusy({ format: 'mp4' });
    assert.equal(state.sourceFetches.length, 1);
    source.resolve();
    const first = await pending;
    await expectBusy();
    await first.arrayBuffer();
    const next = await deliver(t, undefined, undefined, { format: 'mp4' });
    assert.equal(next.status, 200);
    await next.arrayBuffer();
});

test('a source fetch failure releases the conversion slot', async (t) => {
    const state = setup(t);
    t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 502 }));
    const failed = await deliver(t, undefined, undefined, { format: 'mp4' });
    assert.equal(failed.status, 502);
    await failed.json();
    const next = await deliver(t);
    assert.equal(next.status, 200);
    await next.arrayBuffer();
    assert.equal(state.conversionUrls.length, 1);
});

test('aborting an active buffered encode does not release it before the encode settles', async (t) => {
    const state = setup(t);
    const started = deferred();
    const encoded = deferred();
    state.ensure = async (buffer) => { started.resolve(); await encoded.promise; return buffer; };
    const controller = new AbortController();
    const pending = deliver(t, undefined, controller.signal, { format: 'mp4' });
    await started.promise;
    controller.abort();
    await expectBusy();
    encoded.resolve();
    const first = await pending;
    await assert.rejects(first.arrayBuffer(), /abort/i);
    await new Promise((resolve) => setImmediate(resolve));
    const next = await deliver(t);
    assert.equal(next.status, 200);
    await next.arrayBuffer();
});

test('raw originals and images remain available while a codec conversion is active', async (t) => {
    const stream = new PassThrough();
    setup(t, { stream });
    const first = await deliver(t);
    const raw = await deliver(t, undefined, undefined, { raw: true, format: 'quicktime' });
    assert.equal(raw.status, 200);
    assert.equal(await raw.text(), 'original MP4 bytes');
    const image = await deliver(t, [{ url: sourceUrl.replace('.mp4', '.png'), name: 'still' }], undefined, { format: 'mov' });
    assert.equal(image.status, 200);
    await image.arrayBuffer();
    stream.end(encodedBytes);
    await first.arrayBuffer();
});

test('canceling a ZIP holds the slot until its current buffered encode settles', async (t) => {
    const state = setup(t);
    const started = deferred();
    const encoded = deferred();
    state.ensure = async (buffer) => { started.resolve(); await encoded.promise; return buffer; };
    const items = [{ url: sourceUrl, name: 'one' }, { url: sourceUrl, name: 'two' }];
    const first = await deliver(t, items, undefined, { format: 'mp4' });
    await started.promise;
    const canceled = first.body.cancel();
    await expectBusy();
    encoded.resolve();
    await canceled;
    const next = await deliver(t);
    assert.equal(next.status, 200);
    await next.arrayBuffer();
    assert.equal(state.sourceFetches.length, 1, 'cancelled ZIP must not start another source read');
});


test('request abort holds the streaming slot until actual encoder exit', async (t) => {
    const stream = new PassThrough();
    const state = setup(t, { stream });
    const exited = deferred();
    const convert = state.convert;
    state.convert = (url) => ({ ...convert(url), done: exited.promise });
    const controller = new AbortController();
    const first = await deliver(t, undefined, controller.signal);
    controller.abort();
    await assert.rejects(first.arrayBuffer(), /abort/i);
    assert.equal(state.cancellations, 1);
    await expectBusy();
    exited.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    nextConversion(state);
    const next = await deliver(t);
    assert.equal(next.status, 200);
    await next.arrayBuffer();
});

test('an unexpected buffered conversion failure releases the slot', async (t) => {
    const state = setup(t);
    state.ensure = async () => { throw new Error('conversion failed'); };
    await assert.rejects(POST(request(undefined, undefined, { format: 'mp4' })), /conversion failed/);
    const next = await deliver(t);
    assert.equal(next.status, 200);
    await next.arrayBuffer();
});

test('a completed video ZIP releases the conversion slot', async (t) => {
    setup(t);
    const items = [{ url: sourceUrl, name: 'one' }, { url: sourceUrl, name: 'two' }];
    const first = await deliver(t, items, undefined, { format: 'mp4' });
    await expectBusy();
    const archive = Buffer.from(await first.arrayBuffer());
    assert.equal(archive.subarray(0, 2).toString(), 'PK');
    const next = await deliver(t);
    assert.equal(next.status, 200);
    await next.arrayBuffer();
});
