// Server-only. TOS4-HMAC-SHA256 signing for BytePlus TOS (object storage) —
// header-signed requests (PUT bucket/object) and query-presigned GET URLs.
// Same key-derivation chain as the asset API signer but service "tos".
// NEVER import into client code — it reads the secret access key.

import crypto from 'node:crypto';

export const TOS_REGION = 'ap-southeast-1';
export const TOS_ENDPOINT = 'tos-ap-southeast-1.bytepluses.com';
const SERVICE = 'tos';
const UNSIGNED = 'UNSIGNED-PAYLOAD';

function sha256Hex(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

function hmac(key, msg) {
    return crypto.createHmac('sha256', key).update(msg, 'utf8').digest();
}

function stamps(date = new Date()) {
    const iso = date.toISOString();
    const dtStr = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
    return { dateStr: dtStr.slice(0, 8), dtStr };
}

function signingKey(sk, dateStr) {
    return hmac(hmac(hmac(hmac(sk, dateStr), TOS_REGION), SERVICE), 'request');
}

// Encode a path so each segment is URI-escaped but "/" survives.
export function encodePath(path) {
    return path.split('/').map((s) => encodeURIComponent(s)).join('/');
}

// Header-signed request headers for PUT/GET/DELETE against a TOS host.
export function signTosRequest({ method, host, path, query = '', ak, sk, extraHeaders = {}, date = new Date() }) {
    const { dateStr, dtStr } = stamps(date);
    const headers = {
        host,
        'x-tos-content-sha256': UNSIGNED,
        'x-tos-date': dtStr,
        ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])),
    };
    const signedNames = Object.keys(headers).sort();
    const canonicalHeaders = signedNames.map((k) => `${k}:${headers[k]}\n`).join('');
    const canonical = [method, path, query, canonicalHeaders, signedNames.join(';'), UNSIGNED].join('\n');
    const scope = `${dateStr}/${TOS_REGION}/${SERVICE}/request`;
    const sts = ['TOS4-HMAC-SHA256', dtStr, scope, sha256Hex(canonical)].join('\n');
    const signature = crypto.createHmac('sha256', signingKey(sk, dateStr)).update(sts, 'utf8').digest('hex');
    return {
        ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.replace(/(^|-)\w/g, (c) => c.toUpperCase()), v])),
        Authorization: `TOS4-HMAC-SHA256 Credential=${ak}/${scope},SignedHeaders=${signedNames.join(';')},Signature=${signature}`,
    };
}

// Query-presigned GET URL (default 12h) that anyone — including BytePlus's
// asset ingester — can fetch without credentials.
export function presignGetUrl({ host, path, ak, sk, expiresSec = 43200, date = new Date() }) {
    const { dateStr, dtStr } = stamps(date);
    const scope = `${dateStr}/${TOS_REGION}/${SERVICE}/request`;
    const params = {
        'X-Tos-Algorithm': 'TOS4-HMAC-SHA256',
        'X-Tos-Credential': `${ak}/${scope}`,
        'X-Tos-Date': dtStr,
        'X-Tos-Expires': String(expiresSec),
        'X-Tos-SignedHeaders': 'host',
    };
    const qs = Object.keys(params).sort()
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
        .join('&');
    const canonical = ['GET', path, qs, `host:${host}\n`, 'host', UNSIGNED].join('\n');
    const sts = ['TOS4-HMAC-SHA256', dtStr, scope, sha256Hex(canonical)].join('\n');
    const signature = crypto.createHmac('sha256', signingKey(sk, dateStr)).update(sts, 'utf8').digest('hex');
    return `https://${host}${path}?${qs}&X-Tos-Signature=${signature}`;
}
