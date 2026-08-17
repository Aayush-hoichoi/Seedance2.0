// Inbound Bot Framework request verification.
//
// The Teams webhook is a PUBLIC endpoint (it matches the /api/webhooks(.*)
// allowlist in middleware.js, so Clerk never sees it). Without this check
// anyone who learns the URL can POST a forged "approve" activity and move real
// money. This is the only thing standing between the open internet and
// decideBudgetRequest.
//
// Microsoft signs every activity with an RS256 JWT:
//   • issuer   https://api.botframework.com
//   • audience our TEAMS_APP_ID
//   • signed by a key published at the Bot Framework JWKS endpoint
//
// Verification is delegated to `jose` rather than hand-rolled — signature
// checking is not a place to be clever. It is a declared dependency even though
// Clerk already pulls it in transitively: relying on a transitive package for
// authentication means a Clerk upgrade could silently remove it.

import { createRemoteJWKSet, jwtVerify } from 'jose';

const ISSUER = 'https://api.botframework.com';
const JWKS_URL = 'https://login.botframework.com/v1/.well-known/keys';

// Cached across invocations: `jose` refreshes on unknown `kid` and rate-limits
// itself, so key rotation is handled without making Microsoft's availability a
// hard dependency of every single approval.
let jwks = null;
const keySet = () => (jwks ??= createRemoteJWKSet(new URL(JWKS_URL)));

// → { ok: true, payload } | { ok: false, reason }
export async function verifyTeamsRequest(authorizationHeader, { appId = process.env.TEAMS_APP_ID } = {}) {
    if (!appId) return { ok: false, reason: 'TEAMS_APP_ID is not configured' };
    const token = /^Bearer\s+(.+)$/i.exec(String(authorizationHeader || ''))?.[1];
    if (!token) return { ok: false, reason: 'missing bearer token' };
    try {
        const { payload } = await jwtVerify(token, keySet(), {
            issuer: ISSUER,
            audience: appId,          // a token minted for another bot must not work here
            clockTolerance: 60,       // seconds; clock skew, not a grace period for expiry
        });
        return { ok: true, payload };
    } catch (err) {
        return { ok: false, reason: err?.code || err?.message || 'jwt verification failed' };
    }
}
