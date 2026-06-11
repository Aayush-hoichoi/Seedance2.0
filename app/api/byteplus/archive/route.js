import { NextResponse } from 'next/server';
import { signTosRequest, presignGetUrl, encodePath, TOS_ENDPOINT } from '../../../../lib/byteplus/tosSign.js';

// Archive a finished generation into the user's own TOS bucket so it outlives
// ModelArk's ~24h signed URLs / ~48h task records. POST { url, taskId } —
// the server downloads the video and PUTs it to videos/<taskId>.mp4, returning
// a fresh presigned URL + the stable key.
// GET ?key=… re-presigns an archived (or uploaded) object — pure HMAC math,
// no TOS round-trip — so history cards can refresh their URLs forever.

export const runtime = 'nodejs';
export const maxDuration = 120;

const BUCKET = process.env.TOS_BUCKET?.trim() || 'seedance-studio-assets';
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const KEY_RE = /^(videos|uploads)\/[\w.-]+$/;

function credentials() {
    const ak = process.env.ARK_AK?.trim();
    const sk = process.env.ARK_SK?.trim();
    return ak && sk ? { ak, sk } : null;
}

export async function POST(request) {
    const creds = credentials();
    if (!creds) return NextResponse.json({ error: 'ARK_AK / ARK_SK are not configured.' }, { status: 500 });

    let body;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
    }
    const { url, taskId } = body || {};
    if (!url || !taskId) return NextResponse.json({ error: 'url and taskId are required.' }, { status: 400 });
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return NextResponse.json({ error: 'url is not a valid URL.' }, { status: 400 });
    }
    // Only fetch from BytePlus's own media hosts — this is not an open proxy.
    if (!/\.(volces\.com|bytepluses\.com)$/.test(parsed.hostname)) {
        return NextResponse.json({ error: 'url must be a BytePlus media URL.' }, { status: 400 });
    }

    try {
        const upstream = await fetch(url);
        if (!upstream.ok) {
            return NextResponse.json({ error: `Could not download the video (${upstream.status}) — the link may have expired.` }, { status: 502 });
        }
        const buf = Buffer.from(await upstream.arrayBuffer());
        if (buf.length > MAX_VIDEO_BYTES) {
            return NextResponse.json({ error: 'Video too large to archive.' }, { status: 413 });
        }

        const host = `${BUCKET}.${TOS_ENDPOINT}`;
        const key = `videos/${taskId.replace(/[^\w.-]+/g, '_')}.mp4`;
        const path = `/${encodePath(key)}`;
        const headers = signTosRequest({
            method: 'PUT', host, path,
            ak: creds.ak, sk: creds.sk,
            extraHeaders: { 'content-type': 'video/mp4' },
        });
        const put = await fetch(`https://${host}${path}`, { method: 'PUT', headers, body: buf });
        if (!put.ok) {
            const text = await put.text().catch(() => '');
            return NextResponse.json({ error: `Archive upload failed (${put.status}): ${text.slice(0, 200)}` }, { status: 502 });
        }

        const signed = presignGetUrl({ host, path, ak: creds.ak, sk: creds.sk, expiresSec: 604800 }); // 7 days (TOS max)
        return NextResponse.json({ key, url: signed });
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 502 });
    }
}

// Re-presign an archived object key → fresh 7-day URL. Local HMAC only.
export async function GET(request) {
    const creds = credentials();
    if (!creds) return NextResponse.json({ error: 'ARK_AK / ARK_SK are not configured.' }, { status: 500 });
    const key = new URL(request.url).searchParams.get('key') || '';
    if (!KEY_RE.test(key)) return NextResponse.json({ error: 'Invalid key.' }, { status: 400 });
    const host = `${BUCKET}.${TOS_ENDPOINT}`;
    const url = presignGetUrl({ host, path: `/${encodePath(key)}`, ak: creds.ak, sk: creds.sk, expiresSec: 604800 });
    return NextResponse.json({ key, url });
}
