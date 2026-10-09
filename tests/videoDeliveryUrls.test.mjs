import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { presignGetUrl, TOS_ENDPOINT } from '../lib/byteplus/tosSign.js';
import { tosPresignExpired } from '../lib/seedance/tosPresign.mjs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const bucket = 'test-delivery-videos';
const tosOrigin = `https://${bucket}.${TOS_ENDPOINT}`;
const cdnOrigin = 'https://d-delivery-test.cloudfront.net';
const signedAt = new Date('2026-10-09T15:25:47.931Z');
const stateKey = '__videoDeliveryUrlsTest';
const bundled = await build({
    stdin: {
        contents: `export { presignKey, toItem } from './lib/seedance/galleryItem.mjs';
            export { GET, POST } from './app/api/byteplus/archive/route.js';`,
        resolveDir: fileURLToPath(new URL('..', import.meta.url)),
        sourcefile: 'video-delivery-test.mjs',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [{
        name: 'archive-infrastructure',
        setup(builder) {
            builder.onResolve({ filter: /^next\/server$/ }, () => ({ path: 'next', namespace: 'delivery-test' }));
            builder.onResolve({ filter: /\/archiveVideo\.mjs$/ }, () => ({ path: 'archive', namespace: 'delivery-test' }));
            builder.onLoad({ filter: /.*/, namespace: 'delivery-test' }, ({ path }) => ({
                contents: path === 'next'
                    ? 'export const NextResponse = { json: (body, init) => Response.json(body, init) };'
                    : `export async function archiveVideo(input) {
                        globalThis.${stateKey}.push(input);
                        return { key: 'videos/task-123.mp4' };
                    }`,
                loader: 'js',
            }));
        },
    }],
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`;
let importId = 0;

async function setup(t, enabled = true) {
    const values = {
        TOS_BUCKET: bucket,
        ARK_AK: 'test-ark-ak',
        ARK_SK: 'test-ark-sk',
        VIDEO_CDN_DOMAIN: enabled ? cdnOrigin : undefined,
        VIDEO_CDN_KEY_PAIR_ID: enabled ? 'KDELIVERYTEST' : undefined,
        VIDEO_CDN_PRIVATE_KEY: enabled ? privateKey : undefined,
    };
    for (const [key, value] of Object.entries(values)) {
        const previous = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
        t.after(() => {
            if (previous === undefined) delete process.env[key];
            else process.env[key] = previous;
        });
    }
    globalThis[stateKey] = [];
    t.after(() => { delete globalThis[stateKey]; });
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Delivery URL tests must not perform network requests.'); });
    // Both production modules read the bucket once at module initialization.
    return import(`${moduleUrl}#${++importId}`);
}

function dateFromStamp(stamp) {
    return new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);
}

function expectedTos(key, date, expiresSec = 604800) {
    return presignGetUrl({ host: `${bucket}.${TOS_ENDPOINT}`, path: `/${key}`, ak: 'test-ark-ak', sk: 'test-ark-sk', date, expiresSec });
}

function assertCdn(value, key, expiresSec = 604800) {
    const url = new URL(value);
    const date = dateFromStamp(url.searchParams.get('X-Tos-Date'));
    const expiry = date.getTime() + expiresSec * 1000;
    assert.equal(url.origin, cdnOrigin);
    assert.equal(url.pathname, `/${key}`);
    assert.equal(url.searchParams.get('X-Tos-Expires'), String(expiresSec));
    assert.equal(url.searchParams.get('Expires'), String(expiry / 1000));
    assert.equal(url.searchParams.get('Key-Pair-Id'), 'KDELIVERYTEST');
    const resource = value.slice(0, value.indexOf('&Expires='));
    assert.equal(resource, expectedTos(key, date, expiresSec).replace(tosOrigin, cdnOrigin));
    const policy = JSON.stringify({ Statement: [{ Resource: resource, Condition: { DateLessThan: { 'AWS:EpochTime': expiry / 1000 } } }] });
    const signature = Buffer.from(url.searchParams.get('Signature').replace(/-/g, '+').replace(/~/g, '/').replace(/_/g, '='), 'base64');
    assert.equal(verify('RSA-SHA1', Buffer.from(policy), publicKey, signature), true);
    assert.equal(tosPresignExpired(value, expiry - 300_001), false, 'the CDN URL remains usable before the refresh window');
    assert.equal(tosPresignExpired(value, expiry - 299_999), true, 'existing clients refresh inside the five-minute window');
    assert.equal(tosPresignExpired(value, expiry - 1, 0), false);
    assert.equal(tosPresignExpired(value, expiry + 1, 0), true);
}

function assertTos(value, key) {
    const url = new URL(value);
    assert.equal(url.origin, tosOrigin);
    assert.equal(value, expectedTos(key, dateFromStamp(url.searchParams.get('X-Tos-Date'))));
    for (const name of ['Expires', 'Signature', 'Key-Pair-Id']) assert.equal(url.searchParams.has(name), false);
}

function getRequest(key) {
    return new Request(`https://app.example/api/byteplus/archive?key=${encodeURIComponent(key)}`);
}

function postRequest() {
    return new Request('https://app.example/api/byteplus/archive', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://provider.bytepluses.com/task-123.mp4', taskId: 'task-123' }),
    });
}

test('gallery videos use signed CDN URLs with matching origin expiry and existing refresh behavior', async (t) => {
    const { presignKey, toItem } = await setup(t);
    const signed = presignKey('videos/task-123.mp4', { date: signedAt });
    assert.equal(new URL(signed).searchParams.get('X-Tos-Date'), '20261009T152547Z');
    assertCdn(signed, 'videos/task-123.mp4');
    assertCdn(presignKey('videos/task-123.mp4', { date: signedAt, expiresSec: 600 }), 'videos/task-123.mp4', 600);
    const item = toItem({ task_id: 'task-123', category: 'video', status: 'succeeded', exr_archive_key: 'exr/task-123.mov' });
    assertCdn(item.archiveUrl, 'videos/task-123.mp4');
    assertTos(item.exrUrl, 'exr/task-123.mov');
    assert.deepEqual(globalThis[stateKey], [], 'gallery reads never archive media');
});

test('archive GET refresh and POST completion both return signed CDN video URLs', async (t) => {
    const { GET, POST } = await setup(t);
    for (const response of [await GET(getRequest('videos/task-123.mp4')), await POST(postRequest())]) {
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.key, 'videos/task-123.mp4');
        assertCdn(body.url, body.key);
    }
    assert.deepEqual(globalThis[stateKey], [{ url: 'https://provider.bytepluses.com/task-123.mp4', taskId: 'task-123' }]);
});

test('configured CDN leaves gallery images, uploaded references, and EXR downloads on TOS', async (t) => {
    const { presignKey, toItem, GET } = await setup(t);
    for (const key of ['images/job-42-0.png', 'uploads/reference.mp4', 'exr/task-123.mov', 'exr/task-123.mp4']) {
        assert.equal(presignKey(key, { date: signedAt }), expectedTos(key, signedAt));
        const response = await GET(getRequest(key));
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.key, key);
        assertTos(body.url, key);
    }
    const item = toItem({ task_id: 'job-42', category: 'image', images: [{ key: 'images/job-42-0.png' }, { key: 'images/job-42-1.png' }] });
    assert.equal(item.archiveUrl, null);
    assertTos(item.imageUrl, 'images/job-42-0.png');
    item.imageUrls.forEach((url, i) => assertTos(url, `images/job-42-${i}.png`));
    assert.deepEqual(globalThis[stateKey], []);
});

test('without CDN configuration gallery and archive routes preserve original TOS URLs', async (t) => {
    const { presignKey, toItem, GET, POST } = await setup(t, false);
    const key = 'videos/task-123.mp4';
    assert.equal(presignKey(key, { date: signedAt }), expectedTos(key, signedAt));
    assertTos(toItem({ task_id: 'task-123', category: 'video' }).archiveUrl, key);
    for (const response of [await GET(getRequest(key)), await POST(postRequest())]) {
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.key, key);
        assertTos(body.url, key);
    }
});
