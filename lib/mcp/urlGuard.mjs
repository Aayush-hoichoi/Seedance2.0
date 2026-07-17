// lib/mcp/urlGuard.mjs — SSRF guard for reference-image URLs the MCP server
// fetches server-side (lib/mcp/tools/generate.js's fetchRefsAsParts). Pure
// module, zero framework imports, node --test runs it directly.

// [network, prefix] — private/reserved IPv4 space a server-side fetch must
// never reach.
const PRIVATE_IPV4_BLOCKS = [
    ['10.0.0.0', 8],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['0.0.0.0', 8],
];

const BLOCKED_HOSTNAME_SUFFIXES = ['.local', '.internal'];

function badRefUrl(message) {
    const err = new Error(message);
    err.code = 'BAD_REF_URL';
    return err;
}

function ipv4ToInt(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
    return parts.reduce((acc, p) => (acc << 8) + Number(p), 0) >>> 0;
}

function isPrivateIpv4(hostname) {
    const int = ipv4ToInt(hostname);
    if (int === null) return false;
    return PRIVATE_IPV4_BLOCKS.some(([base, prefix]) => {
        const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
        return (int & mask) === (ipv4ToInt(base) & mask);
    });
}

// ponytail: hostname-level checks only — literal IP ranges + a
// localhost/.local/.internal name blocklist. This does NOT resolve DNS or
// pin IPs, so a hostname that resolves to a private address only at fetch
// time (DNS rebinding) slips through. Upgrade path if refs ever accept
// untrusted third-party domains at scale: resolve the hostname, pin the
// resulting IP for the actual fetch (and re-check on every redirect hop).
export function assertPublicHttpUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        throw badRefUrl('Not a valid URL.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw badRefUrl('URL must be http or https.');
    }
    const hostname = url.hostname.toLowerCase();
    if (hostname.startsWith('[')) {
        throw badRefUrl('IPv6 literal hosts are not allowed.');
    }
    if (hostname === 'localhost' || BLOCKED_HOSTNAME_SUFFIXES.some((s) => hostname.endsWith(s))) {
        throw badRefUrl('That host is not a public address.');
    }
    if (isPrivateIpv4(hostname)) {
        throw badRefUrl('That host is not a public address.');
    }
    return url;
}
