import { NextResponse } from 'next/server';

// Server-side proxy to BytePlus ModelArk. The browser calls /api/byteplus/*,
// this route re-issues the request to ModelArk with the Bearer key injected
// from the server-only ARK_API_KEY env var. Keeps the key out of the client
// and sidesteps ModelArk CORS (it has no browser-facing CORS headers).

export const runtime = 'nodejs';

const ARK_BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3';

function buildTargetUrl(pathSegments, requestUrl) {
    const path = (pathSegments || []).join('/');
    const { search } = new URL(requestUrl);
    return `${ARK_BASE}/${path}${search}`;
}

function arkHeaders(extra = {}) {
    const key = process.env.ARK_API_KEY;
    if (!key) return null;
    return {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...extra,
    };
}

function missingKeyResponse() {
    return NextResponse.json(
        { error: 'ARK_API_KEY is not configured on the server. Add it to .env.local and restart the dev server.' },
        { status: 500 },
    );
}

async function forward(targetUrl, init) {
    const response = await fetch(targetUrl, init);
    const text = await response.text();
    // ModelArk returns JSON; pass through status + body. Fall back to raw text
    // so upstream error pages still surface useful detail to the client.
    try {
        return NextResponse.json(JSON.parse(text), { status: response.status });
    } catch {
        return NextResponse.json(
            { error: text.slice(0, 500) || response.statusText },
            { status: response.status },
        );
    }
}

export async function GET(request, { params }) {
    const headers = arkHeaders();
    if (!headers) return missingKeyResponse();
    const { path } = await params;
    const targetUrl = buildTargetUrl(path, request.url);
    try {
        return await forward(targetUrl, { method: 'GET', headers });
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 502 });
    }
}

export async function POST(request, { params }) {
    const headers = arkHeaders();
    if (!headers) return missingKeyResponse();
    const { path } = await params;
    const targetUrl = buildTargetUrl(path, request.url);
    try {
        const body = await request.text();
        return await forward(targetUrl, { method: 'POST', headers, body });
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 502 });
    }
}
