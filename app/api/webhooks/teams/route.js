// Microsoft Teams bot endpoint — the Approve / Deny buttons on budget-request
// cards. Public (it matches the /api/webhooks(.*) allowlist in middleware.js),
// authenticated instead by Microsoft's Bot Framework JWT plus an approver
// allowlist. Same posture as the Slack handler, which authenticates by signing
// secret rather than session.
//
// Set this as the Azure Bot's messaging endpoint:
//   https://<production-host>/api/webhooks/teams
//
// Until that is set, nothing reaches this route and the rest of the feature
// (card delivery, console decisions) works exactly as it does today.

import { NextResponse } from 'next/server';
import { decideBudgetRequest } from '../../../../lib/budgetRequests.mjs';
import { verifyTeamsRequest } from '../../../../lib/teams/verify.mjs';
import { resolveTeamsAdmin } from '../../../../lib/teams/identity.mjs';
import {
    buildDecidedCard, loadBudgetRequestPayload, markTeamsCardDecided, updateTeamsBudgetCards,
} from '../../../../lib/notify/teams.mjs';

export const runtime = 'nodejs';

const VERBS = { budget_approve: 'approve', budget_deny: 'deny' };

// Action.Execute expects an invoke response whose body carries the replacement
// card. Returning it is what stops a decided request looking actionable.
const cardResponse = (card) => NextResponse.json({
    statusCode: 200,
    type: 'application/vnd.microsoft.card.adaptive',
    value: card,
});

// Errors are shown to the admin in-place rather than failing silently: a button
// that appears to do nothing is worse than one that explains itself.
const messageResponse = (text) => NextResponse.json({
    statusCode: 200,
    type: 'application/vnd.microsoft.activity.message',
    value: text,
});

export async function POST(request) {
    // 1. Microsoft, or someone pretending to be. Fail closed.
    const verified = await verifyTeamsRequest(request.headers.get('authorization'));
    if (!verified.ok) {
        console.error('[teams] rejected unverified request:', verified.reason);
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const activity = await request.json().catch(() => null);
    const verb = activity?.value?.action?.verb;
    const action = VERBS[verb];
    // One Azure Bot has ONE messaging endpoint, so every other HoichoiOS card
    // action arrives here too. Anything that is not ours is acknowledged and
    // ignored — a non-2xx would make Microsoft retry someone else's traffic.
    if (!action) return NextResponse.json({}, { status: 200 });

    const data = activity?.value?.action?.data || {};
    const requestId = String(data.requestId || '');
    if (!requestId) return messageResponse('This card is missing its request id — decide it in the console.');

    // 2. An authorised admin, or merely someone holding a valid Teams token.
    const aadObjectId = activity?.from?.aadObjectId;
    const identity = await resolveTeamsAdmin(aadObjectId);
    if (!identity.ok) {
        console.error('[teams] rejected decision:', identity.reason, aadObjectId);
        return messageResponse(`You are not able to decide budget requests here (${identity.reason}).`);
    }

    // 3. The decision itself — the SAME function the console calls. No second
    //    implementation, so quota arithmetic, the model grant, the audit row and
    //    the requester notification are identical whichever surface acts.
    let result;
    try {
        result = await decideBudgetRequest({
            id: requestId,
            action,
            admin: identity.admin,
            policy: data.policy === 'soft' ? 'soft' : 'hard',
            reason: typeof data.reason === 'string' ? data.reason : null,
            // Only meaningful on approve; decideBudgetRequest ignores it on deny.
            approvedAmount: action === 'approve' ? data.approvedAmount : null,
        });
    } catch (err) {
        console.error('[teams] decision failed:', err.message);
        return messageResponse('Could not record that decision — try the console.');
    }

    const payload = await loadBudgetRequestPayload(requestId);

    // Already decided elsewhere (the console, or another admin's card). This is
    // the self-healing path: a stale card cannot double-decide, it just shows
    // what actually happened.
    if (result?.error === 'decided') {
        const decided = payload ? buildDecidedCard(payload, { status: 'approved', decidedBy: 'another admin' }) : null;
        return decided
            ? cardResponse(decided)
            : messageResponse('This request was already decided.');
    }
    if (result?.error) {
        const explain = {
            not_found: 'That request no longer exists.',
            amount: 'Enter an approved amount greater than zero.',
            limit: 'The resulting budget limit must be greater than zero.',
            policy: 'Select either a hard or soft limit.',
            model_inactive: 'The requested model is no longer active.',
            quality_unconfigured: 'Quality tiers are not configured for every selected model.',
            requester_ineligible: 'The requester is no longer an active member of that project.',
        }[result.error] || 'Could not record that decision — try the console.';
        return messageResponse(explain);
    }

    const decision = {
        status: action === 'approve' ? 'approved' : 'denied',
        decidedBy: identity.admin.name || identity.admin.email,
        reason: typeof data.reason === 'string' && data.reason.trim() ? data.reason.trim() : null,
        ...(action === 'approve' ? result : {}),
    };

    // The acting admin's card is replaced by the response below; the others are
    // rewritten out-of-band. Never awaited into the response path — a slow
    // fan-out must not delay the acknowledgement Microsoft is waiting for.
    markTeamsCardDecided({ requestId, aadObjectId }).catch(() => {});
    if (payload) {
        updateTeamsBudgetCards({ requestId, request: payload, decision, skipAadObjectId: aadObjectId })
            .catch((err) => console.error('[teams] fan-out failed:', err.message));
    }

    return payload
        ? cardResponse(buildDecidedCard(payload, decision))
        : messageResponse(action === 'approve' ? 'Approved.' : 'Denied.');
}
