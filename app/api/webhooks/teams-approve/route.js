// One-tap budget decision from a Teams card link — no Azure Bot messaging
// endpoint involved. The link itself (lib/teams/magicLink.mjs) is the only
// thing authorising the decision: it is minted once, for one admin and one
// action, at send time, and decideBudgetRequest's one-shot guard means even a
// leaked or reused link can only ever replay the SAME decision.
//
// Public (matches the /api/webhooks(.*) allowlist in middleware.js) —
// reached directly from a tap in Teams, so there is no session and no Clerk
// user on this request.

import { getDb } from '../../../../lib/db/neon.js';
import { decideBudgetRequest } from '../../../../lib/budgetRequests.mjs';
import { verifyApprovalToken } from '../../../../lib/teams/magicLink.mjs';
import {
    loadBudgetRequestPayload, markTeamsCardDecided, updateTeamsBudgetCards,
} from '../../../../lib/notify/teams.mjs';

export const runtime = 'nodejs';

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
    not_found: 'That request no longer exists.',
    amount: 'The requested amount is no longer valid — decide this from the console.',
    limit: 'The resulting budget limit must be greater than zero — decide this from the console.',
    policy: 'Could not apply the default limit policy — decide this from the console.',
    model_inactive: 'The requested model is no longer active.',
    quality_unconfigured: 'Quality tiers are not configured for every selected model.',
    requester_ineligible: 'The requester is no longer an active member of that project.',
};

export async function GET(request) {
    const token = new URL(request.url).searchParams.get('token');
    let verified;
    try {
        verified = verifyApprovalToken(token);
    } catch (err) {
        console.error('[teams] link verification failed:', err.message);
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
    if (verified.payload.kind !== 'budget') {
        return page('This link no longer works', 'It is invalid. Decide this request from the console instead.', 400);
    }
    const { requestId, adminUserId, aadObjectId, action } = verified.payload;

    const sql = await getDb();
    if (!sql) return page('Unavailable', 'The budget request store is unreachable right now — try again shortly.', 503);

    const [admin] = await sql`SELECT id, email, name, role FROM users WHERE id = ${adminUserId} AND deleted_at IS NULL LIMIT 1`;
    if (!admin || admin.role !== 'admin') {
        return page('Not authorised', 'This account can no longer decide budget requests. Use the console instead.', 403);
    }

    let result;
    try {
        result = await decideBudgetRequest({
            id: requestId, action, admin: { userId: admin.id, email: admin.email, name: admin.name }, sql,
        });
    } catch (err) {
        console.error('[teams] link decision failed:', err.message);
        return page('Something went wrong', 'Could not record that decision — try the console.', 500);
    }

    if (result?.error === 'decided') {
        return page('Already decided', 'Someone already acted on this request — check the console for the outcome.');
    }
    if (result?.error) {
        return page('Could not decide this request', ERROR_COPY[result.error] || 'Could not record that decision — try the console.', 409);
    }

    const payload = await loadBudgetRequestPayload(requestId, sql);
    const decision = {
        status: action === 'approve' ? 'approved' : 'denied',
        decidedBy: admin.name || admin.email,
        ...(action === 'approve' ? result : {}),
    };

    // Never awaited into the response: the decision already committed, and a
    // slow fan-out to the other admins' cards must not delay this page.
    markTeamsCardDecided({ requestId, aadObjectId, sql }).catch(() => {});
    if (payload) {
        updateTeamsBudgetCards({ requestId, request: payload, decision, skipAadObjectId: aadObjectId, sql })
            .catch((err) => console.error('[teams] fan-out failed:', err.message));
    }

    const amount = action === 'approve' ? ` — ${`$${Number(result.approvedIncrease ?? 0).toFixed(2)}`}` : '';
    return page(
        action === 'approve' ? `Approved${amount}` : 'Denied',
        payload?.userName ? `Recorded. ${payload.userName} can generate against it now.` : 'Recorded.',
    );
}
