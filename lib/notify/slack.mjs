// Server-only Slack notifications via an Incoming Webhook. One fetch, no auth
// beyond the webhook URL — nothing to install, no external mail filtering.
//
// Best-effort by design: if SLACK_WEBHOOK_URL isn't set, or the POST fails, we
// log and return a falsy result — a Slack hiccup must never block the access
// request/approval that triggered it.
//
//   SLACK_WEBHOOK_URL   the Incoming Webhook URL (secret; you set it in env)
//   SLACK_MENTION       optional ping prepended to the message text, e.g.
//                       "<@U012ABC>" (a user id) or "<!channel>" / "<!here>"

import { MODELS, IMAGE_MODELS, supportedResolutionsFor } from '../seedance/constants.js';

const webhookUrl = () => process.env.SLACK_WEBHOOK_URL || '';

export function slackConfigured() {
    return webhookUrl() !== '';
}

function modelLabel(modelId) {
    const m = [...MODELS, ...IMAGE_MODELS].find((x) => x.id === modelId);
    return m ? m.name : (modelId || 'the model');
}

// Slack mrkdwn only needs &, <, > escaped — matters for the user-supplied note.
function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function appBase() {
    const raw = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
        || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
    return raw ? raw.replace(/\/+$/, '') : '';
}

function mention() {
    const m = process.env.SLACK_MENTION;
    return m ? `${m} ` : '';
}

// Build a Block Kit message: a header, a two-column field section (empty fields
// dropped), and an optional actions row. `actions` may hold link buttons and/or
// interactive buttons — passed through as-is.
export function slackMessage(fallback, headerText, fields, actions) {
    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: headerText, emoji: true } },
        {
            type: 'section',
            fields: fields.filter((f) => f.value != null && f.value !== '')
                .map((f) => ({ type: 'mrkdwn', text: `*${f.title}:*\n${esc(f.value)}` })),
        },
    ];
    if (actions && actions.length) blocks.push({ type: 'actions', elements: actions });
    return { text: `${mention()}${fallback}`, blocks };
}

// A confirm dialog so a stray tap can't grant/deny access.
const dialog = (title, bodyMd) => ({
    title: { type: 'plain_text', text: title },
    text: { type: 'mrkdwn', text: bodyMd },
    confirm: { type: 'plain_text', text: 'Yes' },
    deny: { type: 'plain_text', text: 'Cancel' },
});
const approveConfirm = (model, email) => dialog('Approve access?', `Grant *${esc(model)}* to ${esc(email)} until the selected expiry date?`);
const denyConfirm = (model, email) => dialog('Deny access?', `Deny *${esc(model)}* for ${esc(email)}?`);
const denyUpgradeConfirm = (model, email) => dialog('Decline upgrade?', `Decline the quality upgrade on *${esc(model)}* for ${esc(email)}? Their existing access stays as it is.`);

// YYYY-MM-DD for a Slack datepicker initial_date (default expiry = 30 days out).
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

async function post(message) {
    const url = webhookUrl();
    if (!url) {
        console.warn('[notify] SLACK_WEBHOOK_URL not set — skipping Slack post');
        return { ok: false, skipped: true, reason: 'not configured' };
    }
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message),
        });
        if (!res.ok) {
            console.error(`[notify] Slack post failed: HTTP ${res.status}`);
            return { ok: false, status: res.status };
        }
        return { ok: true };
    } catch (err) {
        console.error('[notify] Slack post error:', err.message);
        return { ok: false, error: err.message };
    }
}

// upgradeFrom (a tier token or 'any') marks a quality-UPGRADE ask on a live
// grant: the header and quality field show current → wanted, and Deny gets its
// own action id so declining never touches the existing grant.
export function buildAccessRequestedMessage({ id, email, modelId, projectName, note, maxResolution, upgradeFrom = null }) {
    const model = modelLabel(modelId);
    const base = appBase();
    const upgrade = upgradeFrom != null;
    const fields = [
        { title: 'User', value: email },
        { title: 'Model', value: model },
        { title: 'Project', value: projectName || '—' },
        { title: upgrade ? 'Quality' : 'Requested quality', value: upgrade ? `${upgradeFrom} → ${maxResolution}` : (maxResolution || '') },
        { title: 'Note', value: note || '' },
    ].filter((f) => f.value != null && f.value !== '')
        .map((f) => ({ type: 'mrkdwn', text: `*${f.title}:*\n${esc(f.value)}` }));

    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: upgrade ? '⬆️ Quality upgrade request' : '🔐 New model-access request', emoji: true } },
        { type: 'section', fields },
    ];

    // Interactive controls appear only once interactivity is wired up (signing
    // secret present) and we have the request id to act on; otherwise clicking
    // would hit an un-configured endpoint.
    if (id != null && process.env.SLACK_SIGNING_SECRET) {
        // Row 1: a datepicker for a custom expiry and a quality select (+ the
        // console link). Both picks ride in the button click's state.values,
        // read by the handler. The quality select lets the admin grant LOWER
        // than asked (user wants 4K, admin decides 2K is enough); it defaults
        // to the requested tier, or the model's top tier when none was asked.
        const tiers = supportedResolutionsFor(modelId) ?? [];
        const initialTier = tiers.find((t) => t.toLowerCase() === String(maxResolution ?? '').toLowerCase())
            ?? tiers[tiers.length - 1] ?? null;
        const opt = (t) => ({ text: { type: 'plain_text', text: t }, value: t });
        const expiryRow = [{
            type: 'datepicker', action_id: 'expiry_date',
            initial_date: isoDate(Date.now() + 2 * 86400000),
            placeholder: { type: 'plain_text', text: 'Custom expiry date' },
        }];
        if (initialTier) {
            expiryRow.push({
                type: 'static_select', action_id: 'grant_quality',
                placeholder: { type: 'plain_text', text: 'Quality to grant' },
                initial_option: opt(initialTier),
                options: tiers.map(opt),
            });
        }
        if (base) expiryRow.push({ type: 'button', text: { type: 'plain_text', text: 'Review in console' }, url: `${base}/console/users` });
        blocks.push({ type: 'actions', block_id: 'access_expiry', elements: expiryRow });

        // Row 2: the decision. Approve grants until the picked date; deny declines
        // (for an upgrade: clears only the parked ask, the live grant survives).
        blocks.push({ type: 'actions', block_id: 'access_decision', elements: [
            {
                type: 'button', style: 'primary', action_id: 'access_approve', value: String(id),
                text: { type: 'plain_text', text: '✅ Approve', emoji: true },
                confirm: approveConfirm(model, email),
            },
            {
                type: 'button', style: 'danger', action_id: upgrade ? 'access_deny_upgrade' : 'access_deny', value: String(id),
                text: { type: 'plain_text', text: '🚫 Deny', emoji: true },
                confirm: upgrade ? denyUpgradeConfirm(model, email) : denyConfirm(model, email),
            },
        ] });
    } else if (base) {
        blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Review in console' }, url: `${base}/console/users` }] });
    }

    return { text: `${mention()}New model-access request: ${email} → ${model}`, blocks };
}

export function buildAccessDecidedMessage({ email, modelId, status, expiresAt, maxResolution }) {
    const model = modelLabel(modelId);
    const approved = status === 'approved';
    return slackMessage(
        `${approved ? 'Approved' : 'Declined'}: ${email} → ${model}`,
        approved ? '✅ Model access approved' : '🚫 Model access declined/revoked',
        [
            { title: 'User', value: email },
            { title: 'Model', value: model },
            { title: 'Status', value: approved ? 'Approved' : 'Not granted' },
            { title: 'Quality', value: approved ? (maxResolution || '') : '' },
            { title: 'Access until', value: approved ? (expiresAt ? new Date(expiresAt).toUTCString() : 'no expiry') : '' },
        ],
    );
}

// The /all-access slash command's reply: every active grant as a section with a
// danger Revoke button (action_id access_revoke, value = request id). Revoke
// clicks land on the interaction handler, which refreshes this same list.
// Ephemeral — only the admin who ran the command sees it.
export function buildAccessListMessage(grants) {
    const list = Array.isArray(grants) ? grants : [];
    if (!list.length) {
        return {
            response_type: 'ephemeral',
            text: 'No active model-access grants.',
            blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*No active model-access grants.*\nGated models unlock when you approve a request.' } }],
        };
    }
    // Section blocks cap at 50 per message; leave headroom for the header/context.
    const CAP = 45;
    const interactive = !!process.env.SLACK_SIGNING_SECRET;
    const blocks = [{ type: 'header', text: { type: 'plain_text', text: `🔓 Model access — ${list.length} active`, emoji: true } }];
    for (const g of list.slice(0, CAP)) {
        const model = modelLabel(g.model_id);
        const who = g.user_email || g.user_id || 'unknown';
        const project = g.project_name || (g.project_id ? `#${g.project_id}` : 'any project');
        const until = g.expires_at ? new Date(g.expires_at).toUTCString() : 'no expiry';
        const tier = g.max_resolution ? ` · up to ${esc(g.max_resolution)}` : '';
        const section = {
            type: 'section',
            text: { type: 'mrkdwn', text: `*${esc(who)}* → *${esc(model)}*\n${esc(project)}${tier} · until ${esc(until)}` },
        };
        if (interactive && g.id != null) {
            section.accessory = {
                type: 'button', style: 'danger', action_id: 'access_revoke', value: String(g.id),
                text: { type: 'plain_text', text: 'Revoke', emoji: true },
                confirm: dialog('Revoke access?', `Remove *${esc(model)}* from ${esc(who)}? They lose access immediately.`),
            };
        }
        blocks.push(section);
    }
    if (list.length > CAP) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `+${list.length - CAP} more — see the console.` }] });
    return { response_type: 'ephemeral', text: `${list.length} active model-access grants`, blocks };
}

export function notifySlackAccessRequested(args) {
    return post(buildAccessRequestedMessage(args));
}

export function notifySlackAccessDecided(args) {
    return post(buildAccessDecidedMessage(args));
}
