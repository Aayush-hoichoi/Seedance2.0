// Shared Microsoft Teams transport: authenticate, open a 1:1 conversation,
// post/replace an Adaptive Card. Used by every Teams-approval feature
// (lib/notify/teams.mjs for budget requests, lib/notify/teamsAccess.mjs for
// model-access requests) — one token cache, so two features sending cards
// don't double the calls to Microsoft.
//
// Deliberately OUTBOUND ONLY: nothing here waits on, or requires, an inbound
// Bot Framework endpoint. Cards notify and link to the console; decisions are
// made there, never from the card itself.
//
//   TEAMS_APP_ID          bot app (client) id
//   TEAMS_APP_PASSWORD    client secret (rotate via Entra)
//   TEAMS_TENANT_ID       home tenant: token URL + channelData.tenant.id
//   TEAMS_ADMIN_AAD_IDS   comma-separated AAD object ids to notify

const SMBA = 'https://smba.trafficmanager.net/teams/v3';
const BOT_SCOPE = 'https://api.botframework.com/.default';

// Every Teams call is bounded. Card sends and updates are awaited by request
// handlers, so an unbounded fetch would hang a user's budget request (or an
// admin's decision) on Microsoft's availability.
const TEAMS_TIMEOUT_MS = Number(process.env.TEAMS_TIMEOUT_MS) || 10_000;

export async function teamsFetch(url, options = {}) {
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

export const appId = () => process.env.TEAMS_APP_ID || '';
export const appPassword = () => process.env.TEAMS_APP_PASSWORD || '';
export const tenantId = () => process.env.TEAMS_TENANT_ID || '';

// Recipients are AAD object ids, and the id IS the address: it goes straight to
// the Bot Framework, which is the only Microsoft API this file talks to.
//
// The id addresses a TEAMS identity, which is usually not the account that
// person signs into this app with: 2b436b3a-… is swapnanil.manna@hoichoi.tv in
// Teams, while the same admin's app login is a personal address. Nothing here
// needs the app account — the card only notifies — so the two never have to be
// reconciled.
//
// It was briefly emails resolved through Graph instead, which cost a Graph
// application permission, an extra round trip and an extra failure mode — and
// when it shipped, the id configured here stopped being read, so the one
// configured admin silently received nothing for two days. An id needs no
// lookup and cannot half-resolve.
export function approverIds() {
    return (process.env.TEAMS_ADMIN_AAD_IDS || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

export function teamsConfigured() {
    return !!(appId() && appPassword() && tenantId() && approverIds().length);
}

// Whether the app is *meant* to be talking to Teams. Distinguishes "Teams is
// off" (nothing set — stay quiet) from "Teams is on but misconfigured"
// (credentials present, no recipients — say so), so a delivery list that
// empties out can never pass for a feature that was switched off.
export function teamsMisconfigured() {
    return !!(appId() && appPassword() && tenantId()) && approverIds().length === 0;
}

export function appBase() {
    const raw = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
        || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
    return raw ? raw.replace(/\/+$/, '') : '';
}

// --- tokens ------------------------------------------------------------------
// One Bot Framework token, cached in module scope. Tokens last an hour; the
// 5-minute safety margin keeps a near-expiry token from being handed out.
const cachedBotToken = { value: '', expiresAt: 0 };

// Exported so the Graph client can reuse it: the ledger writer authenticates
// against the SAME Entra app registration as the bot (TEAMS_APP_ID /
// TEAMS_APP_PASSWORD / TEAMS_TENANT_ID), just with a different scope. One
// registration, one secret to rotate, one consent record.
export async function clientCredentialsToken(scope, cache) {
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

export const botToken = () => clientCredentialsToken(BOT_SCOPE, cachedBotToken);

// Report what a fan-out actually did. Card delivery is best-effort by design
// (Teams being down must never fail a budget request), and `Promise.allSettled`
// makes every failure look like a success from the outside — which is how an
// admin can stop receiving cards entirely with nothing in the logs. Every
// rejection is named here, with the id that failed.
export function reportDelivery(kind, ids, results) {
    results.forEach((r, i) => {
        if (r.status === 'rejected') console.error(`[teams] ${kind}: delivery to ${ids[i]} failed — ${r.reason?.message || r.reason}`);
    });
    const sent = results.filter((r) => r.status === 'fulfilled').length;
    if (!sent && results.length) console.error(`[teams] ${kind}: NO admin received a card (${results.length} configured)`);
    // Success is logged too, not just failure. "Nothing in the log" is exactly
    // what a silently-skipped send looks like, so the absence of a line has to
    // mean the send never ran — never that it ran and worked.
    else if (sent) console.log(`[teams] ${kind}: card delivered to ${sent}/${results.length} admin(s)`);
    return sent;
}

export async function openConversation(token, aadObjectId) {
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

export async function postCard(token, conversationId, card) {
    const res = await teamsFetch(`${SMBA}/conversations/${encodeURIComponent(conversationId)}/activities`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cardActivity(card)),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.id) throw new Error(`activity ${res.status}: ${data?.error?.message || 'send failed'}`);
    return data.id;
}

export async function replaceCard(token, conversationId, activityId, card) {
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

// --- shared card chrome --------------------------------------------------

export function header(text, style = 'emphasis') {
    return {
        type: 'Container', style, bleed: true,
        items: [{ type: 'TextBlock', text, size: 'Large', weight: 'Bolder', wrap: true }],
    };
}

export const linkAction = (title, url, style) => ({ type: 'Action.OpenUrl', title, url, ...(style ? { style } : {}) });

export function consoleAction(path, title = 'Open console') {
    const url = appBase();
    return url ? [linkAction(title, `${url}${path}`)] : [];
}
