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
// dropped), and an optional link button to the console.
export function slackMessage(fallback, headerText, fields, buttonUrl) {
    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: headerText, emoji: true } },
        {
            type: 'section',
            fields: fields.filter((f) => f.value != null && f.value !== '')
                .map((f) => ({ type: 'mrkdwn', text: `*${f.title}:*\n${esc(f.value)}` })),
        },
    ];
    if (buttonUrl) {
        blocks.push({
            type: 'actions',
            elements: [{ type: 'button', text: { type: 'plain_text', text: 'Review in console' }, url: buttonUrl }],
        });
    }
    return { text: `${mention()}${fallback}`, blocks };
}

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

export function notifySlackAccessRequested({ email, modelId, projectName, note }) {
    const model = modelLabel(modelId);
    const base = appBase();
    return post(slackMessage(
        `New model-access request: ${email} → ${model}`,
        '🔐 New model-access request',
        [
            { title: 'User', value: email },
            { title: 'Model', value: model },
            { title: 'Project', value: projectName || '—' },
            { title: 'Note', value: note || '' },
        ],
        base ? `${base}/console/users` : null,
    ));
}

export function notifySlackAccessDecided({ email, modelId, status, expiresAt }) {
    const model = modelLabel(modelId);
    const approved = status === 'approved';
    return post(slackMessage(
        `${approved ? 'Approved' : 'Declined'}: ${email} → ${model}`,
        approved ? '✅ Model access approved' : '🚫 Model access declined/revoked',
        [
            { title: 'User', value: email },
            { title: 'Model', value: model },
            { title: 'Status', value: approved ? 'Approved' : 'Not granted' },
            { title: 'Access until', value: approved ? (expiresAt ? new Date(expiresAt).toUTCString() : 'no expiry') : '' },
        ],
    ));
}
