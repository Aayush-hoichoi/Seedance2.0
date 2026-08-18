// Signed, single-purpose links for deciding a Teams card with no inbound Bot
// Framework endpoint at all. Shared by every Teams-approval feature (budget
// requests, model-access requests, ...) — a link is minted once, for one
// admin, one action, and one FEATURE (`kind`), at the moment a card is sent —
// never regenerated, and never valid for anyone or anything it wasn't minted
// for.
//
// `kind` exists because two features mint tokens from the same secret and
// request ids are not namespaced across them (budget-request ids and
// model-access-request ids can collide as raw values) — without it, a token
// minted for one feature's request #5 could be replayed against the other
// feature's decide route if #5 happens to exist there too. Each route checks
// `payload.kind` against the one feature it decides.
//
// This is HMAC-signed, not encrypted. The payload (which request, which admin,
// which action, which feature) is not secret, only its authenticity is.
// Anyone who intercepts a link can see what it would do but cannot forge one,
// and the one-shot guard in the underlying decide function means even a
// leaked or reused link can only ever replay the SAME decision it was minted
// for — never a different amount, never a second grant.

import crypto from 'node:crypto';

// A week — long enough for a slow admin to get to it, short enough to bound
// how long a leaked link stays live.
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Reuses the bot's client secret by default so no new secret has to be minted,
// stored and rotated just for this. TEAMS_LINK_SECRET is there for anyone who
// wants the two rotated independently.
function secret() {
    const s = process.env.TEAMS_LINK_SECRET || process.env.TEAMS_APP_PASSWORD || '';
    if (!s) throw new Error('TEAMS_LINK_SECRET or TEAMS_APP_PASSWORD must be set to sign approval links');
    return s;
}

const sign = (body) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');

export function signApprovalToken({ kind, requestId, adminUserId, aadObjectId, action, ttlMs = DEFAULT_TTL_MS }) {
    if (!kind) throw new Error('kind is required — which feature this link decides');
    const payload = { kind, requestId, adminUserId, aadObjectId, action, exp: Date.now() + ttlMs };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${sign(body)}`;
}

// → { ok: true, payload } | { ok: false, reason }
export function verifyApprovalToken(token) {
    let body, sig;
    try {
        [body, sig] = String(token || '').split('.');
    } catch {
        return { ok: false, reason: 'malformed token' };
    }
    if (!body || !sig) return { ok: false, reason: 'malformed token' };

    let expected;
    try {
        expected = sign(body);
    } catch (err) {
        return { ok: false, reason: err.message };
    }
    const given = Buffer.from(sig);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
        return { ok: false, reason: 'bad signature' };
    }

    let payload;
    try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
        return { ok: false, reason: 'malformed payload' };
    }
    if (!payload?.kind || !payload?.requestId || !payload?.adminUserId || !payload?.action) {
        return { ok: false, reason: 'incomplete payload' };
    }
    if (!Number.isFinite(payload.exp) || Date.now() > payload.exp) {
        return { ok: false, reason: 'expired' };
    }
    return { ok: true, payload };
}
