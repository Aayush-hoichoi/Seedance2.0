import { NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { presignGetUrl, encodePath, TOS_ENDPOINT } from '../../../../lib/byteplus/tosSign.js';

// Same-origin byte fetch for a bucket object: GET /api/tryon/file?key=uploads/…
// The Try-On tool needs the BYTES of stored wardrobe/cast media (to send them
// inline to the image models); fetching a presigned TOS URL from the browser
// is at the mercy of the bucket's CORS config, so this route streams the
// object through our own origin instead. Display (<img>/<video>) keeps using
// presigned URLs from /api/byteplus/archive — media elements need no CORS.

export const runtime = 'nodejs';
export const maxDuration = 60;

const BUCKET = process.env.TOS_BUCKET?.trim() || 'seedance-studio-assets';
const KEY_RE = /^(videos|uploads|images|exr)\/[\w.-]+$/;

export async function GET(request) {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const ak = process.env.ARK_AK?.trim();
    const sk = process.env.ARK_SK?.trim();
    if (!ak || !sk) return NextResponse.json({ error: 'ARK_AK / ARK_SK are not configured.' }, { status: 500 });

    const key = new URL(request.url).searchParams.get('key') || '';
    if (!KEY_RE.test(key)) return NextResponse.json({ error: 'Invalid key.' }, { status: 400 });

    const host = `${BUCKET}.${TOS_ENDPOINT}`;
    const signed = presignGetUrl({ host, path: `/${encodePath(key)}`, ak, sk, expiresSec: 600 });
    const upstream = await fetch(signed);
    if (!upstream.ok) {
        return NextResponse.json({ error: `Storage returned ${upstream.status}.` }, { status: 502 });
    }
    return new NextResponse(upstream.body, {
        headers: {
            'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
            'Cache-Control': 'private, max-age=3600',
        },
    });
}
