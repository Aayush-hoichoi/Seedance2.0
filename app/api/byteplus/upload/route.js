import { NextResponse } from 'next/server';
import { presignUpload, MISSING_CREDENTIALS_ERROR } from '../../../../lib/byteplus/uploadUrl.js';

// Returns a presigned PUT URL so the browser uploads directly to TOS —
// no Vercel body-size limit, no server-side buffering.
// GET /api/byteplus/upload?name=foo.jpg&type=image/jpeg

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(request) {
    const { searchParams } = new URL(request.url);
    const name = searchParams.get('name') || 'file';
    const contentType = searchParams.get('type') || 'application/octet-stream';

    const r = await presignUpload({ name, contentType });
    if (r.error) {
        const status = r.error === MISSING_CREDENTIALS_ERROR ? 500 : 502;
        return NextResponse.json({ error: r.error }, { status });
    }

    return NextResponse.json(r);
}
