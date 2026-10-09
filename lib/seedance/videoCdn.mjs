// Server-only delivery URLs. TOS remains private and authenticates cache
// misses; CloudFront's trusted key group authenticates every viewer request,
// including cache hits. Uploads and non-video media keep their existing URLs.
import { createPrivateKey, sign } from 'node:crypto';
import { TOS_ENDPOINT } from '../byteplus/tosSign.js';

const VIDEO_PATH = /^\/videos\/[\w.-]+\.mp4$/;
const TOS_PARAMETERS = new Set([
    'X-Tos-Algorithm', 'X-Tos-Credential', 'X-Tos-Date',
    'X-Tos-Expires', 'X-Tos-SignedHeaders', 'X-Tos-Signature',
]);
const CLOUDFRONT_PARAMETERS = ['Expires', 'Signature', 'Key-Pair-Id', 'Policy', 'Hash-Algorithm'];
let cachedPem;
let cachedKey;

function tosOrigin() {
    const bucket = process.env.TOS_BUCKET?.trim() || 'seedance-studio-assets';
    return `https://${bucket.toLowerCase()}.${TOS_ENDPOINT}`;
}

export function videoCdnOrigin() {
    const configured = process.env.VIDEO_CDN_DOMAIN?.trim();
    if (!configured) return null;
    let url;
    try {
        if (/[\s\\@]/.test(configured)) throw new Error();
        const value = configured.includes('://') ? configured : `https://${configured}`;
        if (!/^https:\/\/[^/?#]+\/?$/i.test(value)) throw new Error();
        url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.port
            || url.pathname !== '/' || url.search || url.hash
            || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(url.hostname)) {
            throw new Error();
        }
    } catch {
        throw new Error('VIDEO_CDN_DOMAIN must be an HTTPS hostname without a path, credentials, or custom port.');
    }
    return url.origin;
}

function videoUrl(value) {
    if (typeof value !== 'string' || /[\s\\]/.test(value)) return null;
    // Check the original path too: URL parsing normalizes ../ and encoded
    // dot segments. Accept only the canonical, flat archived-video namespace.
    const parts = /^https:\/\/([^/?#]+)(\/[^?#]*)(?:\?[^#]*)?(?:#.*)?$/i.exec(value);
    if (!parts || parts[1].includes('@')) return null;
    try {
        const url = new URL(value);
        if (url.username || url.password || url.port || url.hash
            || parts[2] !== url.pathname || !VIDEO_PATH.test(url.pathname)) return null;
        return url;
    } catch {
        return null;
    }
}

export function isVideoCdnUrl(value) {
    const origin = videoCdnOrigin();
    if (!origin) return false;
    const url = videoUrl(value);
    return !!url && url.origin === origin;
}

function originExpiry(url) {
    const params = url.searchParams;
    if ([...TOS_PARAMETERS].some((name) => params.getAll(name).length !== 1)
        || CLOUDFRONT_PARAMETERS.some((name) => params.has(name))
        || params.get('X-Tos-Algorithm') !== 'TOS4-HMAC-SHA256'
        || params.get('X-Tos-SignedHeaders') !== 'host'
        || !params.get('X-Tos-Credential')
        || !/^[a-f\d]{64}$/i.test(params.get('X-Tos-Signature') || '')) {
        throw new Error('A valid TOS GET presigned URL is required for video CDN delivery.');
    }
    const stamp = params.get('X-Tos-Date');
    const lifetime = params.get('X-Tos-Expires');
    const date = /^\d{8}T\d{6}Z$/.test(stamp || '')
        ? new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`)
        : new Date(NaN);
    if (!Number.isFinite(date.getTime())
        || date.toISOString().replace(/[-:]/g, '').replace('.000', '') !== stamp
        || !/^\d+$/.test(lifetime || '') || Number(lifetime) < 1 || Number(lifetime) > 604800) {
        throw new Error('The TOS URL must have a valid signing date and lifetime of 1–604800 seconds.');
    }
    // Use the origin's signed second, never Date.now(): subsecond differences
    // or renewed viewer expiry must not outlive origin authentication.
    return date.getTime() / 1000 + Number(lifetime);
}

function signingConfiguration() {
    const keyPairId = process.env.VIDEO_CDN_KEY_PAIR_ID?.trim();
    const pem = process.env.VIDEO_CDN_PRIVATE_KEY?.trim().replace(/\\n/g, '\n');
    if (!keyPairId || !pem) {
        throw new Error('VIDEO_CDN_DOMAIN requires VIDEO_CDN_KEY_PAIR_ID and VIDEO_CDN_PRIVATE_KEY.');
    }
    if (!/^[a-z\d]+$/i.test(keyPairId)) throw new Error('VIDEO_CDN_KEY_PAIR_ID must be a CloudFront public key ID.');
    if (pem !== cachedPem) {
        let key;
        try {
            key = createPrivateKey(pem);
            if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 2048) throw new Error();
        } catch {
            throw new Error('VIDEO_CDN_PRIVATE_KEY must contain an RSA 2048 private key.');
        }
        cachedPem = pem;
        cachedKey = key;
    }
    return { keyPairId, privateKey: cachedKey };
}

export function toVideoCdnUrl(originUrl) {
    const origin = videoCdnOrigin();
    if (!origin) return originUrl;
    const url = videoUrl(originUrl);
    if (!url || url.origin !== tosOrigin()) return originUrl;
    const { keyPairId, privateKey } = signingConfiguration();
    const expires = originExpiry(url);
    const resource = `${origin}${url.pathname}${url.search}`;
    const policy = JSON.stringify({ Statement: [{ Resource: resource, Condition: { DateLessThan: { 'AWS:EpochTime': expires } } }] });
    // CloudFront's default canned-policy algorithm is RSA-SHA1. Its base64
    // alphabet differs from base64url: '/' becomes '~' and '=' becomes '_'.
    const signature = sign('RSA-SHA1', Buffer.from(policy), privateKey).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '~').replace(/=/g, '_');
    return `${resource}&Expires=${expires}&Signature=${signature}&Key-Pair-Id=${keyPairId}`;
}

// Provider services still require the TOS hostname. Reuse its original bearer
// signature without extending its lifetime or signing a caller-supplied key.
export function videoOriginUrl(value) {
    if (!isVideoCdnUrl(value)) return value;
    const url = new URL(value);
    const query = [...url.searchParams]
        .filter(([name]) => TOS_PARAMETERS.has(name))
        .map(([name, entry]) => `${encodeURIComponent(name)}=${encodeURIComponent(entry)}`)
        .join('&');
    return `${tosOrigin()}${url.pathname}${query ? `?${query}` : ''}`;
}
