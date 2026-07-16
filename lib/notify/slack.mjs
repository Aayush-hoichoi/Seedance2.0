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

import { MODELS, IMAGE_MODELS } from '../seedance/constants.js';

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

// The approver picks the grant window from these presets (mirrors the console).
export const APPROVE_PRESET_DAYS = [7, 30, 90];

// A confirm dialog so a stray tap can't grant/deny access.
const dialog = (title, bodyMd) => ({
    title: { type: 'plain_text', text: title },
    text: { type: 'mrkdwn', text: bodyMd },
    confirm: { type: 'plain_text', text: 'Yes' },
    deny: { type: 'plain_text', text: 'Cancel' },
});
const approveConfirm = (model, email, windowLabel) => dialog('Approve access?', `Grant *${esc(model)}* to ${esc(email)} for *${esc(windowLabel)}*?`);
const denyConfirm = (model, email) => dialog('Deny access?', `Deny *${esc(model)}* for ${esc(email)}?`);

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

export function buildAccessRequestedMessage({ id, email, modelId, projectName, note }) {
    const model = modelLabel(modelId);
    const base = appBase();
    const fields = [
        { title: 'User', value: email },
        { title: 'Model', value: model },
        { title: 'Project', value: projectName || '—' },
        { title: 'Note', value: note || '' },
    ].filter((f) => f.value != null && f.value !== '')
        .map((f) => ({ type: 'mrkdwn', text: `*${f.title}:*\n${esc(f.value)}` }));

    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: '🔐 New model-access request', emoji: true } },
        { type: 'section', fields },
    ];

    // Interactive controls appear only once interactivity is wired up (signing
    // secret present) and we have the request id to act on; otherwise clicking
    // would hit an un-configured endpoint.
    if (id != null && process.env.SLACK_SIGNING_SECRET) {
        // Row 1: a datepicker for a custom expiry (+ the console link). The picked
        // date rides in the button click's state.values, read by the handler.
        const expiryRow = [{
            type: 'datepicker', action_id: 'expiry_date',
            initial_date: isoDate(Date.now() + 30 * 86400000),
            placeholder: { type: 'plain_text', text: 'Custom expiry date' },
        }];
        if (base) expiryRow.push({ type: 'button', text: { type: 'plain_text', text: 'Review in console' }, url: `${base}/console/users` });
        blocks.push({ type: 'actions', block_id: 'access_expiry', elements: expiryRow });

        // Row 2: the decision. Preset windows + "use the picked date" + deny.
        // action_ids must be unique within a block; the chosen window rides in value.
        const buttons = APPROVE_PRESET_DAYS.map((days) => ({
            type: 'button', style: 'primary', action_id: `access_approve_${days}`, value: `${id}:${days}`,
            text: { type: 'plain_text', text: `✅ ${days} days`, emoji: true },
            confirm: approveConfirm(model, email, `${days} days`),
        }));
        buttons.push({
            type: 'button', style: 'primary', action_id: 'access_approve_custom', value: `${id}:custom`,
            text: { type: 'plain_text', text: '✅ Use picked date', emoji: true },
            confirm: approveConfirm(model, email, 'the picked date'),
        });
        buttons.push({
            type: 'button', style: 'danger', action_id: 'access_deny', value: String(id),
            text: { type: 'plain_text', text: '🚫 Deny', emoji: true },
            confirm: denyConfirm(model, email),
        });
        blocks.push({ type: 'actions', block_id: 'access_decision', elements: buttons });
    } else if (base) {
        blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Review in console' }, url: `${base}/console/users` }] });
    }

    return { text: `${mention()}New model-access request: ${email} → ${model}`, blocks };
}

export function buildAccessDecidedMessage({ email, modelId, status, expiresAt }) {
    const model = modelLabel(modelId);
    const approved = status === 'approved';
    return slackMessage(
        `${approved ? 'Approved' : 'Declined'}: ${email} → ${model}`,
        approved ? '✅ Model access approved' : '🚫 Model access declined/revoked',
        [
            { title: 'User', value: email },
            { title: 'Model', value: model },
            { title: 'Status', value: approved ? 'Approved' : 'Not granted' },
            { title: 'Access until', value: approved ? (expiresAt ? new Date(expiresAt).toUTCString() : 'no expiry') : '' },
        ],
    );
}

export function notifySlackAccessRequested(args) {
    return post(buildAccessRequestedMessage(args));
}

export function notifySlackAccessDecided(args) {
    return post(buildAccessDecidedMessage(args));
}
