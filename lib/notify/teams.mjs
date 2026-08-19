// Microsoft Teams budget-approval cards, via the HoichoiOS bot (Azure Bot
// `CortexAIBot`). Sends an Adaptive Card to each approving admin's 1:1 chat
// with a one-tap Approve/Deny link, and updates it in place once the request
// is decided — from that link or the console.
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
import { signApprovalToken } from '../teams/magicLink.mjs';
import {
    appBase, approverEmails, approverRecipients, teamsConfigured, botToken, resolveAadObjectId,
    openConversation, postCard, replaceCard, header, linkAction, consoleAction,
} from '../teams/bot.mjs';

export { approverEmails, teamsConfigured };

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

// The actionable card. Approve/Deny are plain links to a signed, single-use
// URL (see ../teams/magicLink.mjs) — no `Action.Execute`, no invoke round-trip,
// and no Azure Bot messaging endpoint involved in deciding anything. `links` is
// omitted only for a card built with nowhere to send a decision (Teams
// unconfigured, or the recipient could not be resolved to an app admin) — it
// still renders, just without decision buttons.
export function buildBudgetRequestCard(request, requestId, links = {}) {
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
    const actions = [];
    if (links.approveUrl) actions.push(linkAction('Approve', links.approveUrl, 'positive'));
    if (links.denyUrl) actions.push(linkAction('Deny', links.denyUrl, 'destructive'));
    actions.push(...budgetConsoleAction());
    return {
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.5',
        body,
        actions,
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
    if (!teamsConfigured()) return null;
    const base = appBase();
    if (!base) {
        console.error('[teams] APP_URL (or NEXT_PUBLIC_APP_URL) is not set — cannot build approval links, skipping send');
        return null;
    }
    try {
        const sql = providedSql ?? await getDb();
        if (!sql) return null;
        const token = await botToken();
        const results = await Promise.allSettled(approverRecipients().map(async ({ teamsEmail, appEmail }) => {
            // Two identities, resolved separately: appEmail authorises the
            // decision, teamsEmail receives the card. A recipient with no admin
            // account still gets the card — they asked to be told — but with no
            // approve/deny links, because a link is signed as a specific admin
            // and attributing their tap to someone else would put the wrong
            // name in the audit trail.
            const [admin] = await sql`SELECT id, email, name FROM users
                WHERE lower(email) = ${appEmail} AND role = 'admin' AND deleted_at IS NULL LIMIT 1`;
            if (!admin) {
                console.warn(`[teams] ${teamsEmail} maps to ${appEmail}, which is not an admin in this app — `
                    + 'sending an informational card with no approve/deny. Give them an admin account, or map '
                    + 'the entry as teamsEmail=appAdminEmail in TEAMS_ADMIN_EMAILS.');
            }
            const aadObjectId = await resolveAadObjectId(teamsEmail);
            const conversationId = await openConversation(token, aadObjectId);
            const links = admin ? {
                approveUrl: `${base}/api/webhooks/teams-approve?token=${encodeURIComponent(
                    signApprovalToken({ kind: 'budget', requestId, adminUserId: admin.id, aadObjectId, action: 'approve' }),
                )}`,
                denyUrl: `${base}/api/webhooks/teams-approve?token=${encodeURIComponent(
                    signApprovalToken({ kind: 'budget', requestId, adminUserId: admin.id, aadObjectId, action: 'deny' }),
                )}`,
            } : {};
            const card = buildBudgetRequestCard(request, requestId, links);
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
        for (const r of results) {
            if (r.status === 'rejected') console.error('[teams] card send failed:', r.reason?.message || r.reason);
        }
        return { sent: results.filter((r) => r.status === 'fulfilled' && r.value).length, total: results.length };
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
