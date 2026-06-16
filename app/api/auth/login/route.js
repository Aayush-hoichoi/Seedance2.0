import { NextResponse } from 'next/server';
import {
    AUTH_COOKIE,
    cookieValueFor,
    credentialsMatch,
} from '../../../../lib/auth/credentials.js';

export const runtime = 'nodejs';

const FAIL_DELAY_MS = 400; // blunt brute-forcing of the single shared credential
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function POST(request) {
    let body;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json(
            { success: false, error: 'Invalid request body' },
            { status: 400 },
        );
    }

    const { username, password } = body || {};
    if (
        typeof username !== 'string' ||
        typeof password !== 'string' ||
        !username ||
        !password
    ) {
        return NextResponse.json(
            { success: false, error: 'Username and password are required' },
            { status: 400 },
        );
    }

    let ok;
    try {
        ok = credentialsMatch(username, password);
    } catch (err) {
        console.error('[auth] login route misconfigured:', err.message);
        return NextResponse.json(
            { success: false, error: 'Auth not configured' },
            { status: 500 },
        );
    }

    if (!ok) {
        await delay(FAIL_DELAY_MS);
        return NextResponse.json(
            { success: false, error: 'Invalid credentials' },
            { status: 401 },
        );
    }

    const res = NextResponse.json({ success: true });
    res.cookies.set(AUTH_COOKIE, await cookieValueFor(username, password), {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
        // No maxAge/expires → browser-session cookie (cleared on browser close).
    });
    return res;
}
