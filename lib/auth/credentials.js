// Shared-credential auth gate. Web Crypto only (no Node-specific APIs) so this
// module runs unchanged in Edge middleware and Node route handlers.
//
// No sessions, no signing secret: the cookie value is sha256("username:password")
// and is compared against the same hash derived from env on every request.

export const AUTH_COOKIE = 'll_auth';

// SHA-256 hex of a string using Web Crypto (available in Edge + Node 18+).
export async function sha256Hex(input) {
    const data = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

// Deterministic cookie value for a credential pair.
export async function cookieValueFor(username, password) {
    return sha256Hex(`${username}:${password}`);
}

// Reads + validates the configured credentials. Throws if unset (fail closed).
export function getAuthConfig() {
    const username = process.env.APP_AUTH_USERNAME;
    const password = process.env.APP_AUTH_PASSWORD;
    if (!username || !password) {
        throw new Error(
            'Auth not configured: set APP_AUTH_USERNAME and APP_AUTH_PASSWORD',
        );
    }
    return { username, password };
}

// The cookie value a logged-in browser should carry, derived from env.
export async function expectedCookieValue() {
    const { username, password } = getAuthConfig();
    return cookieValueFor(username, password);
}

// Length-checked equality that compares every character (no early-return on
// first mismatch) to avoid trivial timing leaks. Returns false for non-strings.
export function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

// True if submitted credentials match the configured ones. Throws if unset.
export function credentialsMatch(username, password) {
    const cfg = getAuthConfig();
    const u = safeEqual(username ?? '', cfg.username);
    const p = safeEqual(password ?? '', cfg.password);
    return u && p;
}

// True if a cookie value matches the env-derived hash. Never throws — returns
// false (fail closed) when the cookie is missing or auth is unconfigured.
export async function cookieMatches(value) {
    if (!value) return false;
    try {
        return safeEqual(value, await expectedCookieValue());
    } catch {
        return false;
    }
}
