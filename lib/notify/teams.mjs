// Server-only Microsoft Teams notifications via an incoming webhook — the Power
// Automate "Workflows" URL (recommended; classic connector URLs work too).
//
// Best-effort by design: if TEAMS_WEBHOOK_URL isn't set, or the POST fails, we
// log and return a falsy result — a Teams hiccup must never block the access
// request/approval that triggered it. Set TEAMS_WEBHOOK_URL in env (the URL is
// a secret; you set it, never committed). Delivered inside your M365 tenant, so
// no external mail filtering (Proofpoint/spam) is involved.

import { MODELS, IMAGE_MODELS } from '../seedance/constants.js';

const webhookUrl = () => process.env.TEAMS_WEBHOOK_URL || '';

export function teamsConfigured() {
    return webhookUrl() !== '';
}

function modelLabel(modelId) {
    const m = [...MODELS, ...IMAGE_MODELS].find((x) => x.id === modelId);
    return m ? m.name : (modelId || 'the model');
}

// An Adaptive Card wrapped in the message envelope a Teams webhook expects.
// Facts with an empty value are dropped so the card stays tidy.
export function cardMessage(title, facts) {
    const body = [
        { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: title, wrap: true },
        {
            type: 'FactSet',
            facts: facts.filter((f) => f.value != null && f.value !== '')
                .map((f) => ({ title: f.title, value: String(f.value) })),
        },
    ];
    return {
        type: 'message',
        attachments: [{
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                type: 'AdaptiveCard',
                version: '1.4',
                body,
            },
        }],
    };
}

async function post(message) {
    const url = webhookUrl();
    if (!url) {
        console.warn('[notify] TEAMS_WEBHOOK_URL not set — skipping Teams post');
        return { ok: false, skipped: true, reason: 'not configured' };
    }
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message),
        });
        if (!res.ok) {
            console.error(`[notify] Teams post failed: HTTP ${res.status}`);
            return { ok: false, status: res.status };
        }
        return { ok: true };
    } catch (err) {
        console.error('[notify] Teams post error:', err.message);
        return { ok: false, error: err.message };
    }
}

export function notifyTeamsAccessRequested({ email, modelId, projectName, note }) {
    return post(cardMessage('🔐 New model-access request', [
        { title: 'User', value: email },
        { title: 'Model', value: modelLabel(modelId) },
        { title: 'Project', value: projectName || '—' },
        { title: 'Note', value: note || '' },
    ]));
}

export function notifyTeamsAccessDecided({ email, modelId, status, expiresAt }) {
    const approved = status === 'approved';
    return post(cardMessage(approved ? '✅ Model access approved' : '🚫 Model access declined/revoked', [
        { title: 'User', value: email },
        { title: 'Model', value: modelLabel(modelId) },
        { title: 'Status', value: approved ? 'Approved' : 'Not granted' },
        { title: 'Access until', value: approved ? (expiresAt ? new Date(expiresAt).toUTCString() : 'no expiry') : '' },
    ]));
}
