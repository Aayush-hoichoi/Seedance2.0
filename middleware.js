import { NextResponse } from 'next/server';
import { AUTH_COOKIE, cookieMatches } from './lib/auth/credentials.js';
import { isPublicPath } from './lib/auth/publicPaths.js';

export async function middleware(request) {
    const url = request.nextUrl;
    const { pathname, search } = url;

    // 1) Auth gate (skip public paths).
    if (!isPublicPath(pathname)) {
        const cookie = request.cookies.get(AUTH_COOKIE)?.value;
        const authed = await cookieMatches(cookie);
        if (!authed) {
            if (pathname.startsWith('/api/')) {
                return NextResponse.json(
                    { success: false, error: 'Unauthorized' },
                    { status: 401 },
                );
            }
            const loginUrl = new URL('/login', url);
            loginUrl.searchParams.set('next', pathname + search);
            return NextResponse.redirect(loginUrl, 307);
        }
    }

    // 2) Existing muapi proxy logic (unchanged behaviour).
    const isMuApi =
        pathname.startsWith('/api/workflow') ||
        pathname.startsWith('/api/app') ||
        pathname.startsWith('/api/v1');
    if (isMuApi) {
        const isHandledByRoute =
            pathname.startsWith('/api/v1/creative-agent') ||
            pathname.startsWith('/api/v1/get_upload_url') ||
            pathname.startsWith('/api/v1/upload-binary');
        if (pathname.startsWith('/api/v1') && !isHandledByRoute) {
            const targetUrl = new URL(pathname + search, 'https://api.muapi.ai');
            return NextResponse.rewrite(targetUrl);
        }
    }

    return NextResponse.next();
}

// Run on every route except Next internals and the favicon.
export const config = {
    matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
