import { NextResponse } from 'next/server';
import { signTosRequest, presignPutUrl, presignGetUrl, encodePath, TOS_ENDPOINT } from '../../../../lib/byteplus/tosSign.js';

// Returns a presigned PUT URL so the browser uploads directly to TOS —
// no Vercel body-size limit, no server-side buffering.
// GET /api/byteplus/upload?name=foo.jpg&type=image/jpeg

export const runtime = 'nodejs';
export const maxDuration = 30;

const BUCKET = process.env.TOS_BUCKET?.trim() || 'seedance-studio-assets';

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
    return `Could not create the TOS bucket (${res.status}): ${text.slice(0, 200)}`;
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

export async function GET(request) {
    const creds = credentials();
    if (!creds) {
        return NextResponse.json(
            { error: 'ARK_AK / ARK_SK are not configured — add them to .env.local and restart.' },
            { status: 500 },
        );
    }

    const { searchParams } = new URL(request.url);
    const name = searchParams.get('name') || 'file';
    const contentType = searchParams.get('type') || 'application/octet-stream';

    const bucketProblem = (await ensureBucket(creds)) || (await ensureCors(creds));
    if (bucketProblem) return NextResponse.json({ error: bucketProblem }, { status: 502 });

    const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${sanitizeName(name)}`;
    const host = `${BUCKET}.${TOS_ENDPOINT}`;
    const path = `/${encodePath(key)}`;

    const putUrl = presignPutUrl({ host, path, contentType, ak: creds.ak, sk: creds.sk });
    const getUrl = presignGetUrl({ host, path, ak: creds.ak, sk: creds.sk });

    return NextResponse.json({ putUrl, getUrl, key, contentType });
}
