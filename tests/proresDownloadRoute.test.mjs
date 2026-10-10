import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const stateKey = '__proresDownloadRouteTest';
const source = 'https://seedance-studio-assets.tos-ap-southeast-1.bytepluses.com/videos/test.mp4';
const stubs = {
    'next/server': 'export const NextResponse = { json: (body, init) => Response.json(body, init) };',
    'auth/user.js': 'export const getUser = async () => null;',
    'db/neon.js': 'export const getDb = async () => null;',
    'access/db.js': 'export const recordGenerationEvent = async () => {};',
    'seedance/archiveDownload.mjs': `export const archiveProResDownload = (options) => globalThis.${stateKey}.archive(options);`,
    'seedance/ensureH264.mjs': `
        export const ensureH264 = async buffer => buffer;
        export const remuxToMov = async () => null;
        export const retimeToFps = async () => null;
        export const transcodeUrlToQuickTime = url => globalThis.${stateKey}.convert(url);
        export const transcodeUrlToProRes = url => globalThis.${stateKey}.convert(url);
    `,
};

async function bundleRoute(relativePath) {
    const result = await build({
        entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
        bundle: true, write: false, platform: 'node', format: 'esm',
        plugins: [{ name: 'route-infrastructure', setup(builder) {
            builder.onResolve({ filter: /.*/ }, ({ path }) => {
                const key = Object.keys(stubs).find(name => path === name || path.endsWith(`/${name}`));
                return key ? { path: key, namespace: 'route-test' } : undefined;
            });
            builder.onLoad({ filter: /.*/, namespace: 'route-test' }, ({ path }) => ({ contents: stubs[path], loader: 'js' }));
        } }],
    });
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

// Separate bundles model the separate function entrypoints. Keep the real
// admission module and response lifecycle in each; replace only I/O/encoding.
const regular = await bundleRoute('../app/api/seedance/download/route.js');
const prores = await bundleRoute('../app/api/seedance/download/prores/route.js');

function request(options = {}) {
    return new Request('https://studio.example.com/api/seedance/download/prores', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ url: source, name: 'shot.mp4' }], format: 'prores', delivery: 'stored', ...options }),
    });
}

test('dedicated entrypoint explicitly uses Node with the conversion deadline', () => {
    assert.equal(prores.runtime, 'nodejs');
    assert.equal(prores.maxDuration, 300);
});

test('dedicated entrypoint rejects other formats and raw downloads before conversion', async () => {
    for (const options of [{ format: 'mp4' }, { format: 'mov' }, { format: undefined }, { raw: true }]) {
        const response = await prores.POST(request(options));
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /ProRes/i);
    }
    const invalid = await prores.POST(new Request('https://studio.example.com/api/seedance/download/prores', { method: 'POST', body: '{' }));
    assert.equal(invalid.status, 400);
});

test('active ProRes preparation blocks only its own function pool, not MP4 delivery', async (t) => {
    const stream = new PassThrough();
    const done = new Promise(resolve => stream.once('close', resolve));
    let enteredArchive;
    const started = new Promise(resolve => { enteredArchive = resolve; });
    let conversions = 0;
    const state = {
        convert() { conversions++; return { stream, done, cancel: () => stream.destroy() }; },
        async archive({ conversion, name }) {
            enteredArchive();
            let bytes = 0;
            for await (const chunk of conversion.stream) bytes += chunk.byteLength;
            await conversion.done;
            return { url: 'https://storage.example.com/completed.mov', name, bytes };
        },
    };
    globalThis[stateKey] = state;
    t.mock.method(globalThis, 'fetch', async () => new Response('original H.264 bytes'));
    t.after(() => { stream.destroy(); delete globalThis[stateKey]; });

    const preparing = prores.POST(request());
    await started;
    const blocked = await prores.POST(request());
    assert.equal(blocked.status, 429);
    const mp4 = await regular.POST(request({ format: 'mp4' }));
    assert.equal(mp4.status, 200, 'a long ProRes conversion must not reject an MP4 request');
    assert.equal(await mp4.text(), 'original H.264 bytes');
    assert.equal(conversions, 1);

    stream.end('completed ProRes bytes');
    const result = await preparing;
    assert.equal(result.status, 200);
    assert.equal((await result.json()).bytes, Buffer.byteLength('completed ProRes bytes'));

    state.convert = () => ({ stream: Readable.from(['next ProRes']), done: Promise.resolve(), cancel() {} });
    const next = await prores.POST(request());
    assert.equal(next.status, 200, 'completion must release the dedicated ProRes slot');
    await next.json();
});
