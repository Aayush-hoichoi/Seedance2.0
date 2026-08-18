// One-tap model-access decision from a Teams card link — same design as
// ../teams-approve (budget requests): no Azure Bot messaging endpoint, no
// invoke round-trip. The link itself (lib/teams/magicLink.mjs) authorises the
// decision; decideAccessRequest re-validates the admin at decide-time anyway.
//
// Public (matches the /api/webhooks(.*) allowlist in middleware.js) — reached
// directly from a tap in Teams, so there is no session and no Clerk user here.

import { getDb } from '../../../../lib/db/neon.js';
import { decideAccessRequest } from '../../../../lib/access/decideAccessRequest.mjs';
import { verifyApprovalToken } from '../../../../lib/teams/magicLink.mjs';
import {
    loadAccessRequestPayload, markTeamsAccessCardDecided, updateTeamsAccessCards,
} from '../../../../lib/notify/teamsAccess.mjs';

export const runtime = 'nodejs';

// A Teams link approves with no form to fill in, so it needs a default
// expiry the way budget links default to the exact amount requested. 30 days
// is the console's own middle preset (7/30/90) — a different expiry, or a
// different granted tier, still needs the console.
const DEFAULT_APPROVE_DAYS = 30;

const page = (title, body, status = 200) => new Response(
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
    `<style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:32rem;` +
    `margin:15vh auto 0;padding:0 1.5rem;color:#1b1b1b;text-align:center}` +
    `h1{font-size:1.375rem;margin:0 0 .5rem}p{color:#5b5b5b;margin:0}</style></head>` +
    `<body><h1>${title}</h1><p>${body}</p></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
);

const ERROR_COPY = {
    not_found: 'That request no longer exists, or the upgrade it referred to was already decided.',
    expiry: 'Could not compute a default expiry — decide this from the console.',
    unknown_action: 'Unrecognized action — decide this from the console.',
};

export async function GET(request) {
    const token = new URL(request.url).searchParams.get('token');
    let verified;
    try {
        verified = verifyApprovalToken(token);
    } catch (err) {
        console.error('[teams] access link verification failed:', err.message);
        return page('Something went wrong', 'Could not verify this link — try the console.', 500);
    }
    if (!verified.ok) {
        return page(
            'This link no longer works',
            verified.reason === 'expired' ? 'It has expired. Decide this request from the console instead.'
                : 'It is invalid. Decide this request from the console instead.',
            400,
        );
    }
    if (verified.payload.kind !== 'access') {
        return page('This link no longer works', 'It is invalid. Decide this request from the console instead.', 400);
    }
    const { requestId, adminUserId, aadObjectId, action } = verified.payload;

    const sql = await getDb();
    if (!sql) return page('Unavailable', 'The access request store is unreachable right now — try again shortly.', 503);

    const [admin] = await sql`SELECT id, email, name, role FROM users WHERE id = ${adminUserId} AND deleted_at IS NULL LIMIT 1`;
    if (!admin || admin.role !== 'admin') {
        return page('Not authorised', 'This account can no longer decide access requests. Use the console instead.', 403);
    }

    const validUntil = action === 'approve'
        ? new Date(Date.now() + DEFAULT_APPROVE_DAYS * 86400000).toISOString()
        : null;

    let result;
    try {
        result = await decideAccessRequest({
            id: requestId, action, admin: { userId: admin.id, email: admin.email, name: admin.name }, validUntil,
        });
    } catch (err) {
        console.error('[teams] access link decision failed:', err.message);
        return page('Something went wrong', 'Could not record that decision — try the console.', 500);
    }
    if (result?.error) {
        return page('Could not decide this request', ERROR_COPY[result.error] || 'Could not record that decision — try the console.', 409);
    }

    const payload = await loadAccessRequestPayload(requestId, sql);
    const decision = {
        status: result.status,
        decidedBy: admin.name || admin.email,
        maxResolution: result.row.max_resolution,
        expiresAt: result.row.expires_at,
    };

    // Never awaited into the response: the decision already committed, and a
    // slow fan-out to the other admins' cards must not delay this page.
    markTeamsAccessCardDecided({ requestId, aadObjectId, sql }).catch(() => {});
    if (payload) {
        updateTeamsAccessCards({ requestId, request: payload, decision, skipAadObjectId: aadObjectId, sql })
            .catch((err) => console.error('[teams] access fan-out failed:', err.message));
    }

    const title = result.status === 'approved'
        ? `Approved — ${DEFAULT_APPROVE_DAYS} days at ${result.row.max_resolution || 'the requested quality'}`
        : result.status === 'upgrade_declined' ? 'Upgrade declined' : 'Denied';
    return page(title, payload?.userEmail ? `Recorded for ${payload.userEmail}.` : 'Recorded.');
}
