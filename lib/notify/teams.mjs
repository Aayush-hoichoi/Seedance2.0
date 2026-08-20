// Microsoft Teams budget-request cards, via the HoichoiOS bot (Azure Bot
// `CortexAIBot`). Sends an Adaptive Card to each admin's 1:1 chat when a request
// is created — amount, limit behaviour and note editable in place — and updates
// every copy once the request is decided, from the card or the console.
//
// Requires the Azure Bot's messaging endpoint to point at /api/webhooks/teams;
// without it the cards still deliver and the console still decides, but a tap
// has nowhere to land.
//
// The transport (auth, conversation, post/replace) is shared with every other
// Teams-approval feature — see ../teams/bot.mjs. This file only owns the
// budget-request card shape and the budget-specific send/update/decide glue.
//
// Best-effort throughout, exactly like ./slack.mjs: if the TEAMS_* vars are
// unset, or any call fails, we log and return a falsy result. A Teams outage
// must never turn a successful budget request into an error the user sees, and
// must never block a decision an admin already made.

import { getDb } from '../db/neon.js';
import {
    appBase, approverIds, teamsConfigured, teamsMisconfigured, botToken, reportDelivery,
    openConversation, postCard, replaceCard, header, consoleAction,
} from '../teams/bot.mjs';

export { approverIds, teamsConfigured };

const usd = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);

// --- cards -----------------------------------------------------------------
// Pure builders: unit-testable with no network, like the Slack ones. Teams
// themes Adaptive Cards itself, so nothing here hardcodes colours beyond the
// semantic `Attention`/`Good` accents.

function factSet({ userName, userEmail, projectName, modelName, quality, spent, currentLimit }) {
    return {
        type: 'FactSet',
        spacing: 'Medium',
        facts: [
            { title: 'User', value: userName || userEmail || 'a member' },
            { title: 'Project', value: projectName || '—' },
            { title: 'Model', value: modelName || '—' },
            ...(quality ? [{ title: 'Quality', value: `${quality} and lower` }] : []),
            // The two numbers that make an amount judgeable away from the console.
            { title: 'Spent this month', value: usd(spent) },
            { title: 'Total allotted', value: currentLimit == null ? 'No personal limit' : usd(currentLimit) },
        ],
    };
}

const budgetConsoleAction = () => consoleAction('/console/budget-requests');

// The actionable card: judge the request, adjust the amount, and decide without
// leaving Teams.
//
// Approve/Deny are `Action.Execute`, NOT links. That distinction is the whole
// security model here. An Execute action makes the Teams client send an invoke
// activity signed with a Bot Framework JWT, which /api/webhooks/teams verifies
// before doing anything — something only a real person tapping in a real client
// can produce. A decision URL, by contrast, is decided by whoever fetches it:
// when this card briefly carried `Action.OpenUrl` approve/deny links, Defender
// Safe Links and preview crawlers decided seven requests within ~1s of delivery,
// attributed to admins who never saw them. Never put a decision behind a URL.
export function buildBudgetRequestCard(request, requestId) {
    const body = [
        header('Budget request'),
        {
            type: 'TextBlock', spacing: 'Medium', wrap: true, size: 'ExtraLarge',
            weight: 'Bolder', color: 'Attention', text: usd(request.increaseAmount),
        },
        { type: 'TextBlock', spacing: 'None', isSubtle: true, wrap: true, text: 'requested increase' },
        factSet(request),
    ];
    if (request.reason) {
        body.push({
            type: 'Container', spacing: 'Medium',
            items: [
                { type: 'TextBlock', text: 'Reason', weight: 'Bolder', size: 'Small', isSubtle: true, wrap: true },
                { type: 'TextBlock', text: request.reason, wrap: true },
            ],
        });
    }
    // The inputs ride on the card so an admin can approve a DIFFERENT amount
    // than was asked for, and record why, without opening the console.
    body.push(
        {
            type: 'Input.Number', id: 'approvedAmount', label: 'Approve amount (USD)',
            value: Number(request.increaseAmount), min: 0.01,
        },
        {
            type: 'Input.ChoiceSet', id: 'policy', label: 'Limit behaviour', value: 'hard',
            choices: [
                { title: 'Hard — block at the cap', value: 'hard' },
                { title: 'Soft — warn, allow 5% over', value: 'soft' },
            ],
        },
        { type: 'Input.Text', id: 'reason', label: 'Note (optional)', isMultiline: true },
    );
    return {
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.5',
        body,
        actions: [
            // Action.Execute (not Submit) so the handler can return a replacement
            // card — an approved request must stop looking actionable.
            { type: 'Action.Execute', title: 'Approve', verb: 'budget_approve', data: { requestId } },
            { type: 'Action.Execute', title: 'Deny', verb: 'budget_deny', data: { requestId }, style: 'destructive' },
            ...budgetConsoleAction(),
        ],
    };
}

// What every card becomes once the request is decided, whoever decided it and
// wherever they did it. No actions left that can change anything — the
// decision is terminal.
export function buildDecidedCard(request, decision) {
    const approved = decision?.status === 'approved';
    const amount = approved ? usd(decision.approvedIncrease) : null;
    const body = [
        header(approved ? 'Budget approved' : 'Budget request denied', approved ? 'good' : 'attention'),
    ];
    if (approved) {
        body.push({
            type: 'TextBlock', spacing: 'Medium', wrap: true, size: 'ExtraLarge',
            weight: 'Bolder', color: 'Good', text: amount,
        });
        if (decision.amountAdjusted) {
            body.push({
                type: 'TextBlock', spacing: 'None', isSubtle: true, wrap: true,
                text: `of the ${usd(decision.requestedIncrease)} requested`,
            });
        }
    }
    body.push(factSet(request));
    const trailer = [];
    if (decision?.decidedBy) trailer.push(`${approved ? 'Approved' : 'Denied'} by ${decision.decidedBy}`);
    if (approved && decision?.policy) trailer.push(`${decision.policy} limit`);
    if (approved && decision?.limit != null) trailer.push(`new cap ${usd(decision.limit)}`);
    if (decision?.reason) trailer.push(`“${decision.reason}”`);
    if (trailer.length) {
        body.push({
            type: 'TextBlock', spacing: 'Medium', wrap: true, isSubtle: true, size: 'Small',
            text: trailer.join(' · '),
        });
    }
    return {
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.5',
        body,
        actions: budgetConsoleAction(),
    };
}

// --- delivery ----------------------------------------------------------------

// Fan out to every configured admin. One admin failing (unresolved email, app
// not installed, say) must not stop the others, so each send settles
// independently.
export async function notifyTeamsBudgetRequested({ requestId, request, sql: providedSql = null }) {
    if (!teamsConfigured()) {
        // Credentials but no recipients is a broken config, not a disabled
        // feature — the difference between the two is what let a card list go
        // empty unnoticed. Only the broken case is worth a log line.
        if (teamsMisconfigured()) console.error('[teams] TEAMS_ADMIN_AAD_IDS is empty — no admin will be notified of budget requests');
        return null;
    }
    // A missing APP_URL costs the card its "Open console" button (consoleAction
    // returns nothing without one) but must not cancel the send: the card's job
    // is to tell an admin a request exists, and a notification with no button
    // still does that. It used to abort here because the approve/deny links
    // could not be built — there are none to build now.
    if (!appBase()) console.warn('[teams] APP_URL (or NEXT_PUBLIC_APP_URL) is not set — sending the card without a console link');
    try {
        const sql = providedSql ?? await getDb();
        if (!sql) return null;
        const token = await botToken();
        const ids = approverIds();
        // A recipient who is not linked to an admin account still receives the
        // card and still sees live Approve/Deny buttons — and every tap is then
        // refused, with no way for them to know the fix is a database link they
        // cannot perform. Surface it here, where the operator who configured the
        // id is the one reading the logs.
        try {
            const { describeApprovers } = await import('../teams/identity.mjs');
            for (const row of await describeApprovers({ sql })) {
                if (!row.linked) {
                    console.error(`[teams] approver ${row.aadObjectId} will receive a card it cannot act on (${row.reason}) —`
                        + " link it with: UPDATE users SET teams_aad_object_id = '<id>' WHERE email = '<admin email>'");
                }
            }
        } catch (err) {
            console.error('[teams] could not check approver links:', err.message);
        }
        const results = await Promise.allSettled(ids.map(async (aadObjectId) => {
            const conversationId = await openConversation(token, aadObjectId);
            const card = buildBudgetRequestCard(request, requestId);
            const activityId = await postCard(token, conversationId, card);
            // Recorded so the card can be updated when the request is decided
            // from elsewhere (the console). Without this row the card is frozen:
            // Microsoft will not hand back the activity id after the fact.
            await sql`INSERT INTO teams_budget_cards
                (request_id, aad_object_id, conversation_id, activity_id, state)
                VALUES (${requestId}, ${aadObjectId}, ${conversationId}, ${activityId}, 'pending')
                ON CONFLICT (request_id, aad_object_id) DO UPDATE
                SET conversation_id = EXCLUDED.conversation_id,
                    activity_id = EXCLUDED.activity_id,
                    state = 'pending', updated_at = now()`;
            return activityId;
        }));
        return { sent: reportDelivery('budget request', ids, results), total: results.length };
    } catch (err) {
        console.error('[teams] budget request notify failed:', err.message);
        return null;
    }
}

// Rewrite every card for a decided request. Called after a decision on EITHER
// surface, which is what keeps Teams and the console in agreement.
// `skipAadObjectId` is the admin who acted from Teams — their card is already
// replaced by the link's confirmation page, so updating it again would be a
// wasted call.
export async function updateTeamsBudgetCards({ requestId, request, decision, skipAadObjectId = null, sql: providedSql = null }) {
    if (!teamsConfigured()) return null;
    try {
        const sql = providedSql ?? await getDb();
        if (!sql) return null;
        const rows = await sql`SELECT aad_object_id, conversation_id, activity_id
            FROM teams_budget_cards WHERE request_id = ${requestId} AND state <> 'decided'`;
        const targets = rows.filter((r) => r.aad_object_id !== skipAadObjectId);
        if (!targets.length) return { updated: 0, total: 0 };
        const token = await botToken();
        const card = buildDecidedCard(request, decision);
        const results = await Promise.allSettled(targets.map(async (row) => {
            await replaceCard(token, row.conversation_id, row.activity_id, card);
            await sql`UPDATE teams_budget_cards SET state = 'decided', updated_at = now()
                WHERE request_id = ${requestId} AND aad_object_id = ${row.aad_object_id}`;
        }));
        for (const r of results) {
            // A failed update is a cosmetic degradation, never a divergence: the
            // stale card still cannot double-decide, because every action
            // re-validates against the one-shot guard in decideBudgetRequest.
            if (r.status === 'rejected') console.error('[teams] card update failed:', r.reason?.message || r.reason);
        }
        return { updated: results.filter((r) => r.status === 'fulfilled').length, total: targets.length };
    } catch (err) {
        console.error('[teams] budget card update failed:', err.message);
        return null;
    }
}

// Mark the acting admin's card decided without calling Teams — the
// confirmation page already told them the outcome.
export async function markTeamsCardDecided({ requestId, aadObjectId, sql: providedSql = null }) {
    try {
        const sql = providedSql ?? await getDb();
        if (!sql) return;
        await sql`UPDATE teams_budget_cards SET state = 'decided', updated_at = now()
            WHERE request_id = ${requestId} AND aad_object_id = ${aadObjectId}`;
    } catch (err) {
        console.error('[teams] card state update failed:', err.message);
    }
}

// The stored request payload, so a decision made from a Teams link can rebuild
// the same card facts the request was sent with.
export async function loadBudgetRequestPayload(requestId, providedSql = null) {
    const sql = providedSql ?? await getDb();
    if (!sql) return null;
    const [row] = await sql`SELECT after FROM audit_log
        WHERE target_type = 'budget_request' AND target_id = ${requestId}
          AND action = 'budget_request.created' ORDER BY created_at DESC LIMIT 1`;
    return row?.after ?? null;
}
