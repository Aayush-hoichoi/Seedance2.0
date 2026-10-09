import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { presignGetUrl, TOS_ENDPOINT } from '../lib/byteplus/tosSign.js';
import { isVideoCdnUrl, toVideoCdnUrl, videoCdnOrigin, videoOriginUrl } from '../lib/seedance/videoCdn.mjs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const signedAt = new Date('2026-10-09T15:25:47.931Z');
const bucket = 'test-private-videos';
const tosOrigin = `https://${bucket}.${TOS_ENDPOINT}`;
const cdnOrigin = 'https://d123example.cloudfront.net';
const keyPairId = 'KTEST12345';

function configure(t, values = {}) {
    const config = {
        TOS_BUCKET: bucket,
        VIDEO_CDN_DOMAIN: cdnOrigin,
        VIDEO_CDN_KEY_PAIR_ID: keyPairId,
        VIDEO_CDN_PRIVATE_KEY: privateKey,
        ...values,
    };
    const previous = Object.fromEntries(Object.keys(config).map((name) => [name, process.env[name]]));
    for (const [name, value] of Object.entries(config)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    t.after(() => {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
}

function sourceUrl({ path = '/videos/cgt-123_a.b.mp4', expiresSec = 604800 } = {}) {
    return presignGetUrl({
        host: `${bucket}.${TOS_ENDPOINT}`, path,
        ak: 'test-access-key', sk: 'test-secret-not-production',
        expiresSec, date: signedAt,
    });
}

function signatureValid(value) {
    const url = new URL(value);
    const expires = Number(url.searchParams.get('Expires'));
    const signature = Buffer.from(url.searchParams.get('Signature').replace(/-/g, '+').replace(/~/g, '/').replace(/_/g, '='), 'base64');
    // Preserve the exact URL spelling: URLSearchParams serialization can
    // alter percent encoding, and CloudFront signs the full resource string.
    const resource = value.slice(0, value.indexOf('&Expires='));
    const policy = JSON.stringify({ Statement: [{ Resource: resource, Condition: { DateLessThan: { 'AWS:EpochTime': expires } } }] });
    return verify('RSA-SHA1', Buffer.from(policy), publicKey, signature);
}

test('video URLs carry a verifiable CloudFront signature and the exact TOS expiration', (t) => {
    configure(t);
    const source = sourceUrl();
    const signed = toVideoCdnUrl(source);
    const url = new URL(signed);
    assert.equal(url.origin, cdnOrigin);
    assert.equal(url.pathname, '/videos/cgt-123_a.b.mp4');
    assert.equal(url.searchParams.get('Key-Pair-Id'), keyPairId);
    assert.equal(Number(url.searchParams.get('Expires')), Math.floor(signedAt.getTime() / 1000) + 604800);
    assert.ok(signed.startsWith(source.replace(tosOrigin, cdnOrigin) + '&Expires='), 'origin signing parameters are preserved byte-for-byte');
    assert.equal(signatureValid(signed), true);
    assert.equal(signatureValid(signed.replace('cgt-123_a.b.mp4', 'another.mp4')), false);
    assert.equal(signatureValid(signed.replace('X-Tos-Expires=604800', 'X-Tos-Expires=604799')), false);
    assert.equal(isVideoCdnUrl(signed), true);
    assert.equal(videoOriginUrl(signed), source);
});

test('disabled delivery leaves original URLs untouched', (t) => {
    configure(t, { VIDEO_CDN_DOMAIN: undefined });
    for (const value of [sourceUrl(), 'https://other.example/video.mp4', null, undefined, 'not a URL']) {
        assert.equal(toVideoCdnUrl(value), value);
        assert.equal(videoOriginUrl(value), value);
        assert.equal(isVideoCdnUrl(value), false);
    }
    assert.equal(videoCdnOrigin(), null);
});

test('configured CDN fails closed when signing configuration is incomplete or invalid', (t) => {
    configure(t);
    for (const missing of ['VIDEO_CDN_KEY_PAIR_ID', 'VIDEO_CDN_PRIVATE_KEY']) {
        const value = process.env[missing];
        delete process.env[missing];
        assert.throws(() => toVideoCdnUrl(sourceUrl()), /requires VIDEO_CDN_KEY_PAIR_ID and VIDEO_CDN_PRIVATE_KEY/);
        process.env[missing] = value;
    }
    process.env.VIDEO_CDN_PRIVATE_KEY = 'invalid-private-key';
    assert.throws(() => toVideoCdnUrl(sourceUrl()), /RSA 2048 private key/);
    process.env.VIDEO_CDN_PRIVATE_KEY = privateKey;
    process.env.VIDEO_CDN_KEY_PAIR_ID = 'bad&Expires=999';
    assert.throws(() => toVideoCdnUrl(sourceUrl()), /CloudFront public key ID/);
});

test('PEM escaped newlines and canonical HTTPS hostname spellings work', (t) => {
    configure(t, {
        VIDEO_CDN_DOMAIN: 'D123EXAMPLE.CLOUDFRONT.NET',
        VIDEO_CDN_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
    });
    assert.equal(videoCdnOrigin(), cdnOrigin);
    assert.equal(signatureValid(toVideoCdnUrl(sourceUrl())), true);
    process.env.VIDEO_CDN_DOMAIN = 'https://D123EXAMPLE.CLOUDFRONT.NET:443/';
    assert.equal(videoCdnOrigin(), cdnOrigin);
    assert.equal(isVideoCdnUrl(`${cdnOrigin.toUpperCase()}:443/videos/task.mp4`), true);
});

test('only the configured private TOS bucket and video namespace are rewritten', (t) => {
    configure(t);
    const source = sourceUrl();
    const untouched = [
        source.replace(tosOrigin, 'https://another-bucket.' + TOS_ENDPOINT),
        source.replace(tosOrigin, 'https://cdn.other.example'),
        source.replace(tosOrigin, 'http://' + `${bucket}.${TOS_ENDPOINT}`),
        source.replace(tosOrigin, tosOrigin + '.evil.example'),
        source.replace(tosOrigin, tosOrigin + ':8443'),
        source.replace('https://', 'https://user:password@'),
        source.replace('/videos/', '/uploads/'),
        source.replace('.mp4?', '.mov?'),
        source.replace('/videos/', '/images/'),
        source.replace('/videos/', '/other/../videos/'),
        source.replace('/videos/', '/other/%2e%2e/videos/'),
        source.replace('/videos/', '/videos%2f'),
        source.replace('cgt-123', '%63gt-123'),
        source + '#fragment',
    ];
    for (const value of untouched) assert.equal(toVideoCdnUrl(value), value);
});

test('CDN recognition rejects foreign hosts, credentials, ports, and normalized path traversal', (t) => {
    configure(t);
    const path = '/videos/task.mp4';
    assert.equal(isVideoCdnUrl(cdnOrigin + path), true);
    for (const value of [
        'https://another.cloudfront.net' + path,
        cdnOrigin + '.evil.example' + path,
        cdnOrigin + ':8443' + path,
        'http://d123example.cloudfront.net' + path,
        'https://user@d123example.cloudfront.net' + path,
        'https://@d123example.cloudfront.net' + path,
        cdnOrigin + '/other/..' + path,
        cdnOrigin + '/other/%2E%2E' + path,
        cdnOrigin + '/videos/nested/task.mp4',
        cdnOrigin + '/videos%2Ftask.mp4',
        cdnOrigin + '/videos/task%2emp4',
        cdnOrigin + '/videos/task.mp4#fragment',
        cdnOrigin + '\\videos\\task.mp4',
        cdnOrigin + '/videos/task.mp4\n',
        cdnOrigin + '/images/task.mp4',
    ]) {
        assert.equal(isVideoCdnUrl(value), false, value);
        assert.equal(videoOriginUrl(value), value);
    }
});

test('origin reconstruction forwards only existing TOS signing fields without renewal', (t) => {
    configure(t);
    const source = sourceUrl({ expiresSec: 60 });
    const signed = toVideoCdnUrl(source);
    const withExtra = `${signed}&unexpected=discard&Policy=discard&Hash-Algorithm=discard`;
    assert.equal(videoOriginUrl(withExtra), source);
    const original = new URL(source).searchParams;
    const restored = new URL(videoOriginUrl(withExtra)).searchParams;
    assert.deepEqual([...restored], [...original]);
    delete process.env.VIDEO_CDN_PRIVATE_KEY;
    assert.equal(videoOriginUrl(signed), source, 'provider compatibility must not require or regenerate a viewer signature');
});

test('malformed or missing TOS authentication is never wrapped as a usable CDN URL', (t) => {
    configure(t);
    assert.throws(() => toVideoCdnUrl(`${tosOrigin}/videos/task.mp4`), /TOS GET presigned URL/);
    for (const mutate of [
        (url) => url.searchParams.delete('X-Tos-Signature'),
        (url) => url.searchParams.append('X-Tos-Date', '20261009T152547Z'),
        (url) => url.searchParams.set('X-Tos-Algorithm', 'other-algorithm'),
        (url) => url.searchParams.set('X-Tos-SignedHeaders', 'content-type;host'),
        (url) => url.searchParams.set('X-Tos-Signature', 'not-a-signature'),
        (url) => url.searchParams.set('Expires', '9999999999'),
        (url) => url.searchParams.set('X-Tos-Date', '20260230T152547Z'),
        (url) => url.searchParams.set('X-Tos-Expires', '0'),
        (url) => url.searchParams.set('X-Tos-Expires', '604801'),
    ]) {
        const url = new URL(sourceUrl());
        mutate(url);
        assert.throws(() => toVideoCdnUrl(url.href), /TOS/);
    }
});

test('non-origin CDN configuration is rejected', (t) => {
    configure(t);
    for (const domain of ['http://cdn.example.com', 'https://user@cdn.example.com',
        'https://cdn.example.com:8443', 'https://cdn.example.com/videos',
        'https://cdn.example.com/videos/..', 'https://cdn.example.com/videos/%2e%2e',
        'https://cdn.example.com?anything=1', 'https://cdn.example.com#fragment',
        'https://cdn.example.com\\videos', 'not a hostname']) {
        process.env.VIDEO_CDN_DOMAIN = domain;
        assert.throws(() => videoCdnOrigin(), /HTTPS hostname/);
    }
});
