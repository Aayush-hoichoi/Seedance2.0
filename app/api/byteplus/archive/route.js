import { NextResponse } from 'next/server';
import { presignGetUrl, encodePath, TOS_ENDPOINT } from '../../../../lib/byteplus/tosSign.js';
import { archiveVideo } from '../../../../lib/seedance/archiveVideo.mjs';

// Archive a finished generation into the user's own TOS bucket so it outlives
// ModelArk's ~24h signed URLs / ~48h task records. POST { url, taskId } —
// the server downloads the video and PUTs it to videos/<taskId>.mp4, returning
// a fresh presigned URL + the stable key.
// GET ?key=… re-presigns an archived (or uploaded) object — pure HMAC math,
// no TOS round-trip — so history cards can refresh their URLs forever.

export const runtime = 'nodejs';
export const maxDuration = 120;

const BUCKET = process.env.TOS_BUCKET?.trim() || 'seedance-studio-assets';
const KEY_RE = /^(videos|uploads|images)\/[\w.-]+$/;

function credentials() {
    const ak = process.env.ARK_AK?.trim();
    const sk = process.env.ARK_SK?.trim();
    return ak && sk ? { ak, sk } : null;
}

// Download + archive is shared with the queue processor (lib/seedance/archiveVideo)
// so studio, MCP, and manual re-archives all land the same object. This route
// adds the browser's needs on top: JSON parsing and a fresh presigned view URL.
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

    try {
        const { key } = await archiveVideo({ url, taskId });
        const host = `${BUCKET}.${TOS_ENDPOINT}`;
        const signed = presignGetUrl({ host, path: `/${encodePath(key)}`, ak: creds.ak, sk: creds.sk, expiresSec: 604800 }); // 7 days (TOS max)
        return NextResponse.json({ key, url: signed });
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: error.httpStatus || 502 });
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
