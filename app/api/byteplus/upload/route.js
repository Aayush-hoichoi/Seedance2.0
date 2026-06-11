import { NextResponse } from 'next/server';
import { signTosRequest, presignGetUrl, encodePath, TOS_ENDPOINT } from '../../../../lib/byteplus/tosSign.js';

// Server-side file hosting for the Seedance asset pipeline. The browser POSTs a
// file; we PUT it into a TOS bucket on the user's own BytePlus account (signed
// with the server-only AK/SK) and return a 12h presigned GET URL that BytePlus
// CreateAsset can ingest. Bucket is created on first use.

export const runtime = 'nodejs';
export const maxDuration = 120;

// TOS hard-caps a single non-multipart PUT well above this; the real ceiling is
// the largest Seedance input (video ≤ 50 MB).
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

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
    if (res.ok || res.status === 409) return null; // created, exists, or already owned
    const text = await res.text().catch(() => '');
    if (text.includes('AccountDisable')) {
        return 'TOS (object storage) is not activated on your BytePlus account. ' +
            'Activate it once in the console (BytePlus Console → TOS / Object Storage → Activate), then retry.';
    }
    return `Could not create the TOS bucket (${res.status}): ${text.slice(0, 200)}`;
}

export async function POST(request) {
    const creds = credentials();
    if (!creds) {
        return NextResponse.json(
            { error: 'ARK_AK / ARK_SK are not configured — add them to .env.local and restart.' },
            { status: 500 },
        );
    }

    let file;
    try {
        const form = await request.formData();
        file = form.get('file');
    } catch {
        return NextResponse.json({ error: 'Send the file as multipart/form-data under "file".' }, { status: 400 });
    }
    if (!file || typeof file.arrayBuffer !== 'function') {
        return NextResponse.json({ error: 'No file received.' }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json({ error: `File is too large (${Math.round(file.size / 1048576)} MB).` }, { status: 413 });
    }

    try {
        const bucketProblem = await ensureBucket(creds);
        if (bucketProblem) return NextResponse.json({ error: bucketProblem }, { status: 502 });

        const host = `${BUCKET}.${TOS_ENDPOINT}`;
        const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${sanitizeName(file.name)}`;
        const path = `/${encodePath(key)}`;
        const body = Buffer.from(await file.arrayBuffer());

        const put = await tosFetch('PUT', host, path, {
            body, creds, contentType: file.type || 'application/octet-stream',
        });
        if (!put.ok) {
            const text = await put.text().catch(() => '');
            return NextResponse.json({ error: `TOS upload failed (${put.status}): ${text.slice(0, 200)}` }, { status: 502 });
        }

        const url = presignGetUrl({ host, path, ak: creds.ak, sk: creds.sk });
        return NextResponse.json({ url, key });
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 502 });
    }
}
