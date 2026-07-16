// Slack interaction handler for the Approve / Deny buttons on model-access
// request cards. Public (matches the /api/webhooks(.*) middleware allowlist);
// authenticated instead by Slack's request signature.
//
// Security: every request must carry a valid Slack signature (SLACK_SIGNING_SECRET),
// and the clicking Slack user must be in the SLACK_APPROVER_IDS allowlist — a
// signature only proves Slack sent it, not that the clicker may grant access.
//
//   SLACK_SIGNING_SECRET  the Slack app's signing secret (Basic Information)
//   SLACK_APPROVER_IDS    comma-separated Slack member ids allowed to decide
//   SLACK_APPROVE_DAYS    grant window for a Slack approval (default 30)

import { NextResponse } from 'next/server';
import { setRequestStatus } from '../../../../lib/access/db.js';
import { syncGatewayOverride } from '../../../../lib/access/gatewaySync.mjs';
import { nextStatus } from '../../../../lib/access/requestStatus.mjs';
import { verifySlackSignature } from '../../../../lib/slack/verify.mjs';
import { MODELS, IMAGE_MODELS } from '../../../../lib/seedance/constants.js';

export const runtime = 'nodejs';

const modelLabel = (id) => ([...MODELS, ...IMAGE_MODELS].find((m) => m.id === id)?.name) || id || 'the model';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function ephemeral(text) {
    return NextResponse.json({ response_type: 'ephemeral', replace_original: false, text });
}

function outcomeMessage({ approved, email, model, byUser, expiresAt }) {
    const fields = [
        { type: 'mrkdwn', text: `*User:*\n${esc(email)}` },
        { type: 'mrkdwn', text: `*Model:*\n${esc(model)}` },
        { type: 'mrkdwn', text: `*${approved ? 'Approved' : 'Denied'} by:*\n${esc(byUser)}` },
    ];
    if (approved) fields.push({ type: 'mrkdwn', text: `*Access until:*\n${expiresAt ? new Date(expiresAt).toUTCString() : 'no expiry'}` });
    return {
        replace_original: true,
        text: `${approved ? '✅ Approved' : '🚫 Denied'}: ${email} → ${model}`,
        blocks: [
            { type: 'header', text: { type: 'plain_text', text: approved ? '✅ Model access approved' : '🚫 Model access denied', emoji: true } },
            { type: 'section', fields },
        ],
    };
}

export async function POST(request) {
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    const rawBody = await request.text();
    const ok = verifySlackSignature({
        signingSecret,
        signature: request.headers.get('x-slack-signature'),
        timestamp: request.headers.get('x-slack-request-timestamp'),
        rawBody,
    });
    if (!ok) return NextResponse.json({ error: 'bad signature' }, { status: 401 });

    let payload;
    try { payload = JSON.parse(new URLSearchParams(rawBody).get('payload')); }
    catch { return NextResponse.json({ error: 'bad payload' }, { status: 400 }); }

    const act = payload?.actions?.[0];
    if (!act || (act.action_id !== 'access_approve' && act.action_id !== 'access_deny')) {
        return NextResponse.json({ ok: true }); // not one of our buttons — ack and ignore
    }

    // Authz: only allowlisted Slack users may decide.
    const allow = (process.env.SLACK_APPROVER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const clicker = payload.user?.id;
    if (!allow.includes(clicker)) {
        return ephemeral("You're not authorized to approve model access. Ask an admin, or use the console.");
    }

    const requestId = Number(act.value);
    if (!Number.isInteger(requestId) || requestId <= 0) return ephemeral('This request is no longer valid.');

    const approve = act.action_id === 'access_approve';
    const byUser = `${payload.user?.username || payload.user?.name || clicker} (Slack)`;
    const days = Number(process.env.SLACK_APPROVE_DAYS) || 30;
    const validUntil = approve ? new Date(Date.now() + days * 86400000).toISOString() : null;

    const row = await setRequestStatus(requestId, nextStatus(approve ? 'approve' : 'revoke'), byUser, validUntil);
    if (!row) return ephemeral('Request not found — it may already have been handled.');
    try {
        await syncGatewayOverride({
            action: approve ? 'approve' : 'revoke', row, validUntil,
            admin: { userId: `slack:${clicker}`, email: byUser },
        });
    } catch (err) {
        console.error('[slack] gateway sync failed:', err.message); // status is already saved
    }

    return NextResponse.json(outcomeMessage({
        approved: approve, email: row.user_email, model: modelLabel(row.model_id), byUser, expiresAt: row.expires_at,
    }));
}
