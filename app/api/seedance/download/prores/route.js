import { NextResponse } from 'next/server';
import { POST as download } from '../route.js';

// Keep long ProRes preparation in its own serverless function pool so it
// cannot occupy the H.264 download function's conversion slot.
export const runtime = 'nodejs';
export const maxDuration = 300;
export const preferredRegion = 'sin1';

export async function POST(request) {
    let body;
    try {
        body = await request.clone().json();
    } catch {
        return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
    }
    if (body?.format !== 'prores' || body?.raw === true) {
        return NextResponse.json({ error: 'This endpoint prepares ProRes MOV downloads only.' }, { status: 400 });
    }
    return download(request);
}
