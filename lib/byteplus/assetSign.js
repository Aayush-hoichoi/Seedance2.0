// Server-only. HMAC-SHA256 (AWS SigV4-style) signing for the BytePlus ModelArk
// Asset Library APIs on ark.ap-southeast-1.byteplusapi.com. Ported from the
// official demo's _asset_signed_headers(). NEVER import this into client code —
// it reads the secret access key.

import crypto from 'node:crypto';

export const ASSET_HOST = 'ark.ap-southeast-1.byteplusapi.com';
export const ASSET_BASE = `https://${ASSET_HOST}`;
export const ASSET_VERSION = '2024-01-01';
const ASSET_REGION = 'ap-southeast-1';
const ASSET_SERVICE = 'ark';
const SIGNED_HEADERS = 'content-type;host;x-content-sha256;x-date';

function sha256Hex(input) {
    return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function hmac(key, msg) {
    return crypto.createHmac('sha256', key).update(msg, 'utf8').digest();
}

// Two timestamps BytePlus expects: compact date (YYYYMMDD) and ISO basic (YYYYMMDDTHHmmSSZ).
function stamps(date) {
    const iso = date.toISOString(); // 2026-06-11T17:56:36.123Z
    const dt = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
    return { dateStr: dt.slice(0, 8), dtStr: dt };
}

// Build the signed headers for one Asset API call. `bodyStr` MUST be the exact
// string sent as the request body (the signature covers its sha256), so the
// caller signs and sends the identical string — do not re-serialize.
export function signAssetRequest({ action, bodyStr, ak, sk, date = new Date() }) {
    const bodyHash = sha256Hex(bodyStr);
    const { dateStr, dtStr } = stamps(date);
    const query = `Action=${action}&Version=${ASSET_VERSION}`;

    const canonicalHeaders =
        `content-type:application/json\n` +
        `host:${ASSET_HOST}\n` +
        `x-content-sha256:${bodyHash}\n` +
        `x-date:${dtStr}\n`;

    const canonicalRequest = ['POST', '/', query, canonicalHeaders, SIGNED_HEADERS, bodyHash].join('\n');

    const credentialScope = `${dateStr}/${ASSET_REGION}/${ASSET_SERVICE}/request`;
    const stringToSign = ['HMAC-SHA256', dtStr, credentialScope, sha256Hex(canonicalRequest)].join('\n');

    const kDate = hmac(sk, dateStr);
    const kRegion = hmac(kDate, ASSET_REGION);
    const kService = hmac(kRegion, ASSET_SERVICE);
    const kSigning = hmac(kService, 'request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    const authorization =
        `HMAC-SHA256 Credential=${ak}/${credentialScope}, ` +
        `SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`;

    return {
        'Content-Type': 'application/json',
        Host: ASSET_HOST,
        'X-Date': dtStr,
        'X-Content-Sha256': bodyHash,
        Authorization: authorization,
    };
}

export function assetUrl(action) {
    return `${ASSET_BASE}/?Action=${action}&Version=${ASSET_VERSION}`;
}
