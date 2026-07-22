import { NextResponse } from 'next/server';
import { signAssetRequest, assetUrl } from '../../../../lib/byteplus/assetSign.js';

// Server-side signed proxy for the BytePlus ModelArk Asset Library APIs.
// The browser POSTs { action, payload }; we sign with the server-only AK/SK and
// forward to ark.ap-southeast-1.byteplusapi.com. Keeps the secret key off the
// client and centralises the HMAC handshake.

export const runtime = 'nodejs';

// Only these actions may be invoked through the proxy.
const ALLOWED_ACTIONS = new Set([
    'ListAssetGroups',
    'ListAssets',
    'GetAsset',
    'CreateAssetGroup',
    'CreateAsset',
    'UpdateAsset',
    'DeleteAsset',
    'DeleteAssetGroup',
]);

function credentials() {
    const ak = process.env.ARK_AK?.trim();
    const sk = process.env.ARK_SK?.trim();
    if (!ak || !sk) return null;
    return { ak, sk };
}

function missingKeysResponse() {
    return NextResponse.json(
        {
            error:
                'Asset Library needs ARK_AK and ARK_SK (HMAC Access Keys, separate from ARK_API_KEY). ' +
                'Add both to .env.local from BytePlus Console → Access Control → Access Keys, then restart the dev server.',
        },
        { status: 500 },
    );
}

export async function POST(request) {
    const creds = credentials();
    if (!creds) return missingKeysResponse();

    let body;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
    }

    const { action, payload } = body || {};
    if (!action || !ALLOWED_ACTIONS.has(action)) {
        return NextResponse.json(
            { error: `Unknown or disallowed asset action: ${action ?? '(none)'}.` },
            { status: 400 },
        );
    }

    // The signature covers the exact body bytes, so sign and send the same string.
    const bodyStr = JSON.stringify(payload ?? {});
    const headers = signAssetRequest({ action, bodyStr, ak: creds.ak, sk: creds.sk });

    try {
        const upstream = await fetch(assetUrl(action), { method: 'POST', headers, body: bodyStr });
        const text = await upstream.text();
        try {
            const json = JSON.parse(text);
            // Capture the raw reason a source asset failed verification: BytePlus
            // is inconsistent about which field carries it and often leaves Error
            // empty, so log the whole Result server-side to triage/learn (the
            // client only ever sees the mapped, friendly message).
            if (action === 'GetAsset' && json?.Result?.Status === 'Failed') {
                console.error('[byteplus] asset verification failed', JSON.stringify(json.Result));
            }
            return NextResponse.json(json, { status: upstream.status });
        } catch {
            return NextResponse.json(
                { error: text.slice(0, 500) || upstream.statusText },
                { status: upstream.status },
            );
        }
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 502 });
    }
}
