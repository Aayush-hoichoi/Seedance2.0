// Shared Microsoft Teams transport: authenticate, open a 1:1 conversation,
// post/replace an Adaptive Card. Used by every Teams-approval feature
// (lib/notify/teams.mjs for budget requests, lib/notify/teamsAccess.mjs for
// model-access requests) — one token cache and one Graph resolver, so two
// features sending cards don't double the calls to Microsoft.
//
// Deliberately OUTBOUND ONLY: nothing here waits on, or requires, an inbound
// Bot Framework endpoint. Every feature built on this decides via a signed
// link (../teams/magicLink.mjs) instead of an Action.Execute invoke.
//
//   TEAMS_APP_ID          bot app (client) id — also the Graph client id
//   TEAMS_APP_PASSWORD    client secret (rotate via Entra) — also signs links
//   TEAMS_TENANT_ID       home tenant: token URL + channelData.tenant.id
//   TEAMS_ADMIN_EMAILS    comma-separated admin emails, shared by every feature

const SMBA = 'https://smba.trafficmanager.net/teams/v3';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const BOT_SCOPE = 'https://api.botframework.com/.default';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

// Every Teams/Graph call is bounded. A card update on the decide path is
// awaited by the confirmation page, so an unbounded fetch would hang that
// response on Microsoft's availability — after the decision already committed.
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

export function approverEmails() {
    return (process.env.TEAMS_ADMIN_EMAILS || '')
        .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

export function teamsConfigured() {
    return !!(appId() && appPassword() && tenantId() && approverEmails().length);
}

export function appBase() {
    const raw = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
        || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
    return raw ? raw.replace(/\/+$/, '') : '';
}

// --- tokens ------------------------------------------------------------------
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

export const botToken = () => clientCredentialsToken(BOT_SCOPE, cachedBotToken);
export const graphToken = () => clientCredentialsToken(GRAPH_SCOPE, cachedGraphToken);

// Email → AAD object id, used only to open a 1:1 conversation. Cached for an
// hour: this rarely changes, and it means adding a new approver costs one
// Graph call, not one per card sent afterwards.
const aadIdCache = new Map();
const AAD_CACHE_TTL_MS = 60 * 60 * 1000;

export async function resolveAadObjectId(email) {
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
