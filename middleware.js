import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

// Reachable without a session so the gate can be passed.
const isPublicRoute = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)']);

export default clerkMiddleware(async (auth, request) => {
    const { pathname, search } = request.nextUrl;

    if (isPublicRoute(request)) return NextResponse.next();

    // 1) Per-user auth gate.
    const { userId } = await auth();
    if (!userId) {
        if (pathname.startsWith('/api/')) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
        }
        const signIn = new URL('/sign-in', request.url);
        signIn.searchParams.set('redirect_url', pathname + search);
        return NextResponse.redirect(signIn, 307);
    }

    // 2) Existing muapi proxy logic (unchanged behaviour), now behind auth.
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
});

// Run on every route except Next internals and the favicon.
export const config = {
    matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
