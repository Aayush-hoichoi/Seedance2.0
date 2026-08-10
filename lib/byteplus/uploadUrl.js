// lib/byteplus/uploadUrl.js — presigned-PUT upload flow, shared by the
// /api/byteplus/upload route and the create_upload_url MCP tool.
import { signTosRequest, presignPutUrl, presignGetUrl, encodePath, TOS_ENDPOINT } from './tosSign.js';

const BUCKET = process.env.TOS_BUCKET?.trim() || 'seedance-studio-assets';

// Exact message presignUpload returns when creds are missing — exported so
// callers (the HTTP route) can tell a 500 (misconfigured server) from a 502
// (bucket/CORS problem) without parsing free-text error strings.
export const MISSING_CREDENTIALS_ERROR = 'ARK_AK / ARK_SK are not configured — add them to .env.local and restart.';

// TOS4 signs `Credential=<ak>/<date>/<region>/tos/request`, so an access key
// containing "/" or "=" makes that header unparseable and TOS answers 400
// AuthorizationHeaderMalformed — which reads as a bucket failure but is really
// a bad env value (an SK pasted into ARK_AK, or an "AK/SK" pair pasted whole).
// A real key is 'AKAP' + 43 unpadded-base64 chars. Reject it here, where we can
// name the cause, rather than shipping an unsignable request.
export const MALFORMED_AK_ERROR = 'ARK_AK is not a valid TOS access key — it must be the AKAP… id on its own, '
    + 'with no "/", "=", quotes or spaces (a secret key pasted into ARK_AK looks exactly like this). '
    + 'Fix the value in the deployment environment.';

function credentials() {
    const ak = process.env.ARK_AK?.trim();
    const sk = process.env.ARK_SK?.trim();
    return ak && sk ? { ak, sk } : null;
}

function sanitizeName(name = 'file') {
    return name.replace(/[^\w.-]+/g, '_').slice(-80) || 'file';
}

async function tosFetch(method, host, path, { query = '', body, contentType, creds } = {}) {
    const headers = signTosRequest({
        method, host, path, query,
        ak: creds.ak, sk: creds.sk,
        extraHeaders: contentType ? { 'content-type': contentType } : {},
    });
    const url = `https://${host}${path}${query ? `?${query}` : ''}`;
    return fetch(url, { method, headers, body });
}

async function ensureBucket(creds) {
    const host = `${BUCKET}.${TOS_ENDPOINT}`;
    const res = await tosFetch('PUT', host, '/', { creds });
    if (res.ok || res.status === 409) return null;
    const text = await res.text().catch(() => '');
    if (text.includes('AccountDisable')) {
        return 'TOS (object storage) is not activated on your BytePlus account. ' +
            'Activate it once in the console (BytePlus Console → TOS / Object Storage → Activate), then retry.';
    }
    // Auth failures are NOT bucket problems — saying "could not create the
    // bucket" sends whoever is on call to look at TOS instead of at the keys.
    if (text.includes('InvalidAccessKeyId')) {
        return 'TOS rejected ARK_AK: that access key does not exist (revoked, deleted, or from another BytePlus account). '
            + 'Create a new HMAC access key pair and update ARK_AK / ARK_SK.';
    }
    if (text.includes('AuthorizationHeaderMalformed')) {
        return `${MALFORMED_AK_ERROR} TOS said: ${text.slice(0, 300)}`;
    }
    if (text.includes('SignatureDoesNotMatch')) {
        return 'TOS rejected the request signature — ARK_AK is a real key but ARK_SK does not match it. '
            + 'Re-copy both halves of the same key pair.';
    }
    return `Could not create the TOS bucket (${res.status}): ${text.slice(0, 300)}`;
}

// Browser PUTs to TOS are cross-origin and preflighted; without a CORS rule on
// the bucket the OPTIONS is rejected and the upload dies as a network error
// ("Load failed"). Idempotent, so re-applying per cold start is fine.
let corsApplied = false;
async function ensureCors(creds) {
    if (corsApplied) return null;
    const host = `${BUCKET}.${TOS_ENDPOINT}`;
    const body = JSON.stringify({
        CORSRules: [{
            AllowedOrigins: ['*'],
            AllowedMethods: ['PUT', 'GET', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 3600,
        }],
    });
    const res = await tosFetch('PUT', host, '/', {
        query: 'cors=', body, contentType: 'application/json', creds,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        return `Could not set CORS on the TOS bucket (${res.status}): ${text.slice(0, 200)}`;
    }
    corsApplied = true;
    return null;
}

// Presigned PUT URL for a direct browser (or curl) → TOS upload, plus a
// presigned GET URL to hand to register_asset once the PUT completes.
// Returns { error } instead of throwing so callers (HTTP route, MCP tool)
// can each map it to their own status code / ToolError.
export async function presignUpload({ name = 'file', contentType = 'application/octet-stream' } = {}) {
    const creds = credentials();
    if (!creds) return { error: MISSING_CREDENTIALS_ERROR };
    if (/[/=\s"']/.test(creds.ak)) return { error: MALFORMED_AK_ERROR };
    const bucketProblem = (await ensureBucket(creds)) || (await ensureCors(creds));
    if (bucketProblem) return { error: bucketProblem };
    const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${sanitizeName(name)}`;
    const host = `${BUCKET}.${TOS_ENDPOINT}`;
    const path = `/${encodePath(key)}`;
    return {
        putUrl: presignPutUrl({ host, path, contentType, ak: creds.ak, sk: creds.sk }),
        getUrl: presignGetUrl({ host, path, ak: creds.ak, sk: creds.sk }),
        key, contentType,
    };
}
