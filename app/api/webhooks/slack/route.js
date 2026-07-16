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
//   SLACK_APPROVE_DAYS    fallback grant window if a button omits one (default 30)

import { NextResponse } from 'next/server';
import { setRequestStatus } from '../../../../lib/access/db.js';
import { syncGatewayOverride } from '../../../../lib/access/gatewaySync.mjs';
import { nextStatus } from '../../../../lib/access/requestStatus.mjs';
import { verifySlackSignature } from '../../../../lib/slack/verify.mjs';
import { MODELS, IMAGE_MODELS } from '../../../../lib/seedance/constants.js';

export const runtime = 'nodejs';

const modelLabel = (id) => ([...MODELS, ...IMAGE_MODELS].find((m) => m.id === id)?.name) || id || 'the model';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// block_actions messages must be updated via response_url, not the HTTP body.
async function respond(responseUrl, body) {
    if (!responseUrl) return;
    try {
        await fetch(responseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (err) {
        console.error('[slack] response_url post failed:', err.message);
    }
}

const note = (text) => ({ response_type: 'ephemeral', replace_original: false, text });

// The custom-expiry datepicker's selected date rides in the interaction's
// state.values (keyed by block/action id); find it regardless of block id.
function pickedDate(payload) {
    for (const block of Object.values(payload?.state?.values || {})) {
        if (block?.expiry_date?.selected_date) return block.expiry_date.selected_date;
    }
    return null;
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
    const rawBody = await request.text();
    const ok = verifySlackSignature({
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        signature: request.headers.get('x-slack-signature'),
        timestamp: request.headers.get('x-slack-request-timestamp'),
        rawBody,
    });
    if (!ok) return NextResponse.json({ error: 'bad signature' }, { status: 401 });

    let payload;
    try { payload = JSON.parse(new URLSearchParams(rawBody).get('payload')); }
    catch { return NextResponse.json({ error: 'bad payload' }, { status: 400 }); }

    // Approve buttons carry unique action_ids (access_approve_7/_30/_90/_custom);
    // the datepicker's own change events (expiry_date) are ignored.
    const act = payload?.actions?.[0];
    const isApprove = !!act?.action_id?.startsWith('access_approve');
    const isDeny = act?.action_id === 'access_deny';
    if (!act || (!isApprove && !isDeny)) {
        return NextResponse.json({ ok: true }); // not one of our buttons — ack and ignore
    }
    const responseUrl = payload.response_url;

    // Authz: only allowlisted Slack users may decide.
    const allow = (process.env.SLACK_APPROVER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const clicker = payload.user?.id;
    if (!allow.includes(clicker)) {
        await respond(responseUrl, note("You're not authorized to approve model access. Ask an admin, or use the console."));
        return NextResponse.json({ ok: true });
    }

    // Value is "<requestId>" (deny) or "<requestId>:<days>" (approve preset).
    const [reqIdStr, daysStr] = String(act.value).split(':');
    const requestId = Number(reqIdStr);
    if (!Number.isInteger(requestId) || requestId <= 0) {
        await respond(responseUrl, note('This request is no longer valid.'));
        return NextResponse.json({ ok: true });
    }
    const approve = isApprove;
    const byUser = `${payload.user?.username || payload.user?.name || clicker} (Slack)`;

    // Resolve the grant window: a custom picked date, or a preset number of days.
    let validUntil = null;
    if (approve) {
        if (daysStr === 'custom') {
            const picked = pickedDate(payload);
            const at = picked ? Date.parse(`${picked}T23:59:59.000Z`) : NaN;
            if (!Number.isFinite(at)) {
                await respond(responseUrl, note('Pick an expiry date first, then click “Use picked date.”'));
                return NextResponse.json({ ok: true });
            }
            if (at <= Date.now()) {
                await respond(responseUrl, note('That expiry date is in the past — pick a future date.'));
                return NextResponse.json({ ok: true });
            }
            validUntil = new Date(at).toISOString();
        } else {
            const days = Number(daysStr) || Number(process.env.SLACK_APPROVE_DAYS) || 30;
            validUntil = new Date(Date.now() + days * 86400000).toISOString();
        }
    }

    const row = await setRequestStatus(requestId, nextStatus(approve ? 'approve' : 'revoke'), byUser, validUntil);
    if (!row) {
        await respond(responseUrl, note('Request not found — it may already have been handled.'));
        return NextResponse.json({ ok: true });
    }
    try {
        await syncGatewayOverride({
            action: approve ? 'approve' : 'revoke', row, validUntil,
            admin: { userId: `slack:${clicker}`, email: byUser },
        });
    } catch (err) {
        console.error('[slack] gateway sync failed:', err.message); // status is already saved
    }

    await respond(responseUrl, outcomeMessage({
        approved: approve, email: row.user_email, model: modelLabel(row.model_id), byUser, expiresAt: row.expires_at,
    }));
    return NextResponse.json({ ok: true });
}
