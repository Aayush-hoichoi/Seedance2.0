// Microsoft Teams budget-approval cards, via the HoichoiOS bot (Azure Bot
// `CortexAIBot`). Sends an Adaptive Card to each approving admin's 1:1 chat and
// updates it in place once the request is decided — from Teams or the console.
//
// Best-effort throughout, exactly like ./slack.mjs: if the TEAMS_* vars are
// unset, or any call fails, we log and return a falsy result. A Teams outage
// must never turn a successful budget request into an error the user sees, and
// must never block a decision an admin already made.
//
//   TEAMS_APP_ID          bot app (client) id — also the JWT audience inbound
//   TEAMS_APP_PASSWORD    client secret (rotate via Entra)
//   TEAMS_TENANT_ID       home tenant: token URL + channelData.tenant.id
//   TEAMS_ADMIN_AAD_IDS   comma-separated AAD object ids to notify
//
// No Microsoft Graph call: recipients are configured by AAD object id, so there
// is no displayName/email lookup to get wrong — which matters in this tenant,
// where hoichoi/Sooper/LoglineAI share several verified domains and a recorded
// address can belong to a different sign-in identity. It also means only ONE
// token scope is ever requested; asking for the Graph scope by mistake does not
// error, it silently fails the next call.

import { getDb } from '../db/neon.js';

const SMBA = 'https://smba.trafficmanager.net/teams/v3';
const BOT_SCOPE = 'https://api.botframework.com/.default';

const appId = () => process.env.TEAMS_APP_ID || '';
const appPassword = () => process.env.TEAMS_APP_PASSWORD || '';
const tenantId = () => process.env.TEAMS_TENANT_ID || '';

export function approverIds() {
    return (process.env.TEAMS_ADMIN_AAD_IDS || '')
        .split(',').map((id) => id.trim()).filter(Boolean);
}

export function teamsConfigured() {
    return !!(appId() && appPassword() && tenantId() && approverIds().length);
}

function appBase() {
    const raw = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
        || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
    return raw ? raw.replace(/\/+$/, '') : '';
}

const usd = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);

// Tokens last an hour. Cached in module scope with a 5-minute safety margin: a
// cold lambda pays for one extra token request, which is the right trade for
// holding no state between invocations.
let cachedToken = { value: '', expiresAt: 0 };

async function botToken() {
    if (cachedToken.value && Date.now() < cachedToken.expiresAt) return cachedToken.value;
    const res = await fetch(`https://login.microsoftonline.com/${tenantId()}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: appId(),
            client_secret: appPassword(),
            scope: BOT_SCOPE,
        }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.access_token) {
        throw new Error(`token ${res.status}: ${data?.error_description || data?.error || 'no access_token'}`);
    }
    cachedToken = {
        value: data.access_token,
        expiresAt: Date.now() + (Number(data.expires_in || 3600) - 300) * 1000,
    };
    return cachedToken.value;
}

async function openConversation(token, aadObjectId) {
    const res = await fetch(`${SMBA}/conversations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            bot: { id: appId(), name: 'HoichoiOS' },
            members: [{ id: aadObjectId }],
            channelData: { tenant: { id: tenantId() } },
        }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.id) {
        // 403 "Bot is not installed in user's personal scope" is the common one:
        // org-catalog approval makes the app available, not installed. The admin
        // adds it themselves, or a Teams Setup Policy pushes it to them.
        throw new Error(`conversation ${res.status}: ${data?.error?.message || 'no conversation id'}`);
    }
    return data.id;
}

const cardActivity = (card) => ({
    type: 'message',
    from: { id: appId(), name: 'HoichoiOS' },
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
});

async function postCard(token, conversationId, card) {
    const res = await fetch(`${SMBA}/conversations/${encodeURIComponent(conversationId)}/activities`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cardActivity(card)),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.id) throw new Error(`activity ${res.status}: ${data?.error?.message || 'send failed'}`);
    return data.id;
}

async function replaceCard(token, conversationId, activityId, card) {
    const res = await fetch(
        `${SMBA}/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`,
        {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(cardActivity(card)),
        },
    );
    if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(`update ${res.status}: ${data?.error?.message || 'update failed'}`);
    }
    return true;
}

// --- cards -------------------------------------------------------------------
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

function header(text, style = 'emphasis') {
    return {
        type: 'Container', style, bleed: true,
        items: [{ type: 'TextBlock', text, size: 'Large', weight: 'Bolder', wrap: true }],
    };
}

function consoleAction() {
    const url = appBase();
    return url ? [{ type: 'Action.OpenUrl', title: 'Open console', url: `${url}/console/budget-requests` }] : [];
}

// The actionable card. `requestId` rides the action data so the handler knows
// its target without parsing anything user-supplied.
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
            ...consoleAction(),
        ],
    };
}

// What every card becomes once the request is decided, whoever decided it and
// wherever they did it. No inputs, no actions — the decision is terminal.
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
        actions: consoleAction(),
    };
}

// --- delivery ----------------------------------------------------------------

// Fan out to every configured admin. One admin failing (app not installed, say)
// must not stop the others, so each send settles independently.
export async function notifyTeamsBudgetRequested({ requestId, request, sql: providedSql = null }) {
    if (!teamsConfigured()) return null;
    try {
        const sql = providedSql ?? await getDb();
        const token = await botToken();
        const card = buildBudgetRequestCard(request, requestId);
        // A recipient who is not linked to an admin account still receives the
        // card and still sees live Approve/Deny buttons — every tap is then
        // refused, and they have no way to know the fix is a database link they
        // cannot perform themselves. Surface it here, where the operator who
        // configured the id is the one reading the logs.
        if (sql) {
            const { describeApprovers } = await import('../teams/identity.mjs');
            for (const row of await describeApprovers({ sql })) {
                if (!row.linked) {
                    console.error(`[teams] approver ${row.aadObjectId} will receive a card it cannot act on (${row.reason}) —`
                        + ' link it with: UPDATE users SET teams_aad_object_id = \'<id>\' WHERE email = \'<admin email>\'');
                }
            }
        }
        const results = await Promise.allSettled(approverIds().map(async (aadObjectId) => {
            const conversationId = await openConversation(token, aadObjectId);
            const activityId = await postCard(token, conversationId, card);
            // Recorded so the card can be updated when the request is decided.
            // Without this row the card is frozen: Microsoft will not tell us the
            // activity id after the fact.
            if (sql) {
                await sql`INSERT INTO teams_budget_cards
                    (request_id, aad_object_id, conversation_id, activity_id, state)
                    VALUES (${requestId}, ${aadObjectId}, ${conversationId}, ${activityId}, 'pending')
                    ON CONFLICT (request_id, aad_object_id) DO UPDATE
                    SET conversation_id = EXCLUDED.conversation_id,
                        activity_id = EXCLUDED.activity_id,
                        state = 'pending', updated_at = now()`;
            }
            return activityId;
        }));
        for (const r of results) {
            if (r.status === 'rejected') console.error('[teams] card send failed:', r.reason?.message || r.reason);
        }
        return { sent: results.filter((r) => r.status === 'fulfilled').length, total: results.length };
    } catch (err) {
        console.error('[teams] budget request notify failed:', err.message);
        return null;
    }
}

// Rewrite every card for a decided request. Called after a decision on EITHER
// surface, which is what keeps Teams and the console in agreement.
// `skipAadObjectId` is the admin who acted from Teams — their card is already
// replaced by the invoke response, so updating it again would be a wasted call.
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

// Mark the acting admin's card decided without calling Teams — the invoke
// response already replaced it.
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

// The stored request payload, so a decision made from Teams can rebuild the same
// card facts the request was sent with.
export async function loadBudgetRequestPayload(requestId, providedSql = null) {
    const sql = providedSql ?? await getDb();
    if (!sql) return null;
    const [row] = await sql`SELECT after FROM audit_log
        WHERE target_type = 'budget_request' AND target_id = ${requestId}
          AND action = 'budget_request.created' ORDER BY created_at DESC LIMIT 1`;
    return row?.after ?? null;
}
