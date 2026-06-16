// Pure path classification for the auth gate. No imports → safe in Edge
// middleware AND unit-testable without pulling in `next/server`.
//
// SECURITY: API routes are NEVER treated as static. A content-type extension
// (e.g. a `.js` suffix) on an `/api/*` path must not skip the gate — the
// key-spending proxy routes (`/api/byteplus/*`, the muapi `/api/v1/*` rewrite,
// and the other catch-alls) match any depth, so a suffixed path would otherwise
// reach the handler unauthenticated.

// Reachable WITHOUT auth, by exact match (otherwise the gate could never be
// passed). Kept exact so a future `/loginXyz` or `/api/auth/other` route is not
// silently made public.
const PUBLIC_EXACT = new Set(['/login', '/api/auth/login']);

// Non-API static assets we never gate (e.g. assets the login page may reference).
const STATIC_FILE_RE =
    /\.(?:png|jpe?g|gif|svg|webp|ico|css|js|map|txt|woff2?|ttf|eot)$/i;

export function isPublicPath(pathname) {
    if (PUBLIC_EXACT.has(pathname)) return true;
    if (pathname.startsWith('/login/')) return true; // future /login subpaths
    if (pathname.startsWith('/api/')) return false; // API is never "static-public"
    return STATIC_FILE_RE.test(pathname);
}
