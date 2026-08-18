// Microsoft Teams budget-approval cards, via the HoichoiOS bot (Azure Bot
// `CortexAIBot`). Sends an Adaptive Card to each approving admin's 1:1 chat
// with a one-tap Approve/Deny link, and updates it in place once the request
// is decided — from that link or the console.
//
// Deliberately OUTBOUND ONLY. Approve/Deny are plain `Action.OpenUrl` links to
// a signed, single-purpose URL (see ../teams/magicLink.mjs) — tapping one just
// opens a page, the way any hyperlink does. That means there is no Azure Bot
// messaging endpoint to configure, no invoke activity to verify, and nothing
// here ever waits on an inbound request. The only Bot Framework calls made are
// the three needed to SEND a message: token, create-conversation, post/replace
// activity.
//
// Best-effort throughout, exactly like ./slack.mjs: if the TEAMS_* vars are
// unset, or any call fails, we log and return a falsy result. A Teams outage
// must never turn a successful budget request into an error the user sees, and
// must never block a decision an admin already made.
//
//   TEAMS_APP_ID          bot app (client) id — also the Graph client id
//   TEAMS_APP_PASSWORD    client secret (rotate via Entra) — also signs links
//   TEAMS_TENANT_ID       home tenant: token URL + channelData.tenant.id
//   TEAMS_ADMIN_EMAILS    comma-separated admin emails to notify
//
// Recipients are configured by EMAIL and resolved to a Teams/AAD object id via
// Microsoft Graph (`User.Read.All`, Application permission) at send time. That
// resolution is used only to ADDRESS a message — it never authorises a
// decision. A decision is authorised by the signed link itself (magicLink.mjs),
// which is minted only once an email has been matched to an actual admin
// account in this app, at the moment the card is sent.

import { getDb } from '../db/neon.js';
import { signApprovalToken } from '../teams/magicLink.mjs';

const SMBA = 'https://smba.trafficmanager.net/teams/v3';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const BOT_SCOPE = 'https://api.botframework.com/.default';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

// Every Teams/Graph call is bounded. The console's approve path AWAITS the card
// update, so an unbounded fetch would hang an admin's approval on Microsoft's
// availability — and the decision has already committed by then, meaning they
// would see an error for something that actually succeeded and would try again.
// A card that updates late (or never) is cosmetic; a false failure is not.
const TEAMS_TIMEOUT_MS = Number(process.env.TEAMS_TIMEOUT_MS) || 10_000;

async function teamsFetch(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEAMS_TIMEOUT_MS);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
        if (err?.name === 'AbortError') throw new Error(`timed out after ${TEAMS_TIMEOUT_MS}ms`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

const appId = () => process.env.TEAMS_APP_ID || '';
const appPassword = () => process.env.TEAMS_APP_PASSWORD || '';
const tenantId = () => process.env.TEAMS_TENANT_ID || '';

export function approverEmails() {
    return (process.env.TEAMS_ADMIN_EMAILS || '')
        .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

export function teamsConfigured() {
    return !!(appId() && appPassword() && tenantId() && approverEmails().length);
}

function appBase() {
    const raw = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
        || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
    return raw ? raw.replace(/\/+$/, '') : '';
}

const usd = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);

// --- tokens --------------------------------------------------------------
// Bot Framework and Graph are different resources even though they share one
// app registration's credentials, so each gets its own cached token. Tokens
// last an hour; cached in module scope with a 5-minute safety margin.
const cachedBotToken = { value: '', expiresAt: 0 };
const cachedGraphToken = { value: '', expiresAt: 0 };

async function clientCredentialsToken(scope, cache) {
    if (cache.value && Date.now() < cache.expiresAt) return cache.value;
    const res = await teamsFetch(`https://login.microsoftonline.com/${tenantId()}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: appId(),
            client_secret: appPassword(),
            scope,
        }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.access_token) {
        throw new Error(`token ${res.status}: ${data?.error_description || data?.error || 'no access_token'}`);
    }
    cache.value = data.access_token;
    cache.expiresAt = Date.now() + (Number(data.expires_in || 3600) - 300) * 1000;
    return cache.value;
}

const botToken = () => clientCredentialsToken(BOT_SCOPE, cachedBotToken);
const graphToken = () => clientCredentialsToken(GRAPH_SCOPE, cachedGraphToken);

// Email → AAD object id, used only to open a 1:1 conversation. Cached for an
// hour: this rarely changes, and it means adding a new approver costs one
// Graph call, not one per card sent afterwards.
const aadIdCache = new Map();
const AAD_CACHE_TTL_MS = 60 * 60 * 1000;

async function resolveAadObjectId(email) {
    const cached = aadIdCache.get(email);
    if (cached && Date.now() < cached.expiresAt) return cached.id;
    const token = await graphToken();
    const res = await teamsFetch(`${GRAPH}/users/${encodeURIComponent(email)}?$select=id`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.id) {
        throw new Error(`graph lookup ${res.status}: ${data?.error?.message || 'no matching Teams user'}`);
    }
    aadIdCache.set(email, { id: data.id, expiresAt: Date.now() + AAD_CACHE_TTL_MS });
    return data.id;
}

async function openConversation(token, aadObjectId) {
    const res = await teamsFetch(`${SMBA}/conversations`, {
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
    const res = await teamsFetch(`${SMBA}/conversations/${encodeURIComponent(conversationId)}/activities`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cardActivity(card)),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.id) throw new Error(`activity ${res.status}: ${data?.error?.message || 'send failed'}`);
    return data.id;
}

async function replaceCard(token, conversationId, activityId, card) {
    const res = await teamsFetch(
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

const linkAction = (title, url, style) => ({ type: 'Action.OpenUrl', title, url, ...(style ? { style } : {}) });

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
    actions.push(...consoleAction());
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
        actions: consoleAction(),
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
        const results = await Promise.allSettled(approverEmails().map(async (email) => {
            // An email with no matching admin account still can't be authorised
            // to decide anything — sending it a card with dead links would be
            // worse than sending nothing. Surface it here, where the operator
            // who configured TEAMS_ADMIN_EMAILS is the one reading the logs.
            const [admin] = await sql`SELECT id, email, name FROM users
                WHERE lower(email) = ${email} AND role = 'admin' AND deleted_at IS NULL LIMIT 1`;
            if (!admin) {
                console.error(`[teams] ${email} has no admin account in this app — no card sent. `
                    + 'TEAMS_ADMIN_EMAILS must list emails that match an admin\'s users.email.');
                return null;
            }
            const aadObjectId = await resolveAadObjectId(email);
            const conversationId = await openConversation(token, aadObjectId);
            const approveUrl = `${base}/api/webhooks/teams-approve?token=${encodeURIComponent(
                signApprovalToken({ requestId, adminUserId: admin.id, aadObjectId, action: 'approve' }),
            )}`;
            const denyUrl = `${base}/api/webhooks/teams-approve?token=${encodeURIComponent(
                signApprovalToken({ requestId, adminUserId: admin.id, aadObjectId, action: 'deny' }),
            )}`;
            const card = buildBudgetRequestCard(request, requestId, { approveUrl, denyUrl });
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
