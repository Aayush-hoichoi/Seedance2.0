// Slack interaction handler for the Approve / Deny buttons on model-access
// request cards, and the Revoke buttons on the /all-access list. Public
// (matches the /api/webhooks(.*) middleware allowlist); authenticated instead
// by Slack's request signature.
//
// Security: every request must carry a valid Slack signature (SLACK_SIGNING_SECRET).
// The request channel is admins-only, so any signature-verified click may decide.
// SLACK_APPROVER_IDS stays supported as an optional allowlist: set it to restrict
// deciders to specific member ids; leave it unset and any admin in the channel can.
//
//   SLACK_SIGNING_SECRET  the Slack app's signing secret (Basic Information)
//   SLACK_APPROVER_IDS    optional: comma-separated Slack member ids allowed to decide
//   SLACK_APPROVE_DAYS    fallback grant window if no expiry date is picked (default 2)

import { NextResponse } from 'next/server';
import { setRequestStatus, denyUpgrade, listActiveGrants } from '../../../../lib/access/db.js';
import { syncGatewayOverride } from '../../../../lib/access/gatewaySync.mjs';
import { nextStatus } from '../../../../lib/access/requestStatus.mjs';
import { verifySlackSignature } from '../../../../lib/slack/verify.mjs';
import { buildAccessListMessage } from '../../../../lib/notify/slack.mjs';
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

// The quality select's pick, same mechanism. null (select untouched and Slack
// sent no state for it) falls back to the tier the user requested — which is
// exactly what the select was initialized to, so both paths agree.
function pickedQuality(payload) {
    for (const block of Object.values(payload?.state?.values || {})) {
        if (block?.grant_quality?.selected_option?.value) return block.grant_quality.selected_option.value;
    }
    return null;
}

function outcomeMessage({ approved, email, model, byUser, expiresAt, maxResolution }) {
    const fields = [
        { type: 'mrkdwn', text: `*User:*\n${esc(email)}` },
        { type: 'mrkdwn', text: `*Model:*\n${esc(model)}` },
        { type: 'mrkdwn', text: `*${approved ? 'Approved' : 'Denied'} by:*\n${esc(byUser)}` },
    ];
    if (approved && maxResolution) fields.push({ type: 'mrkdwn', text: `*Quality:*\nup to ${esc(maxResolution)}` });
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

    // access_approve grants until the picked expiry date; access_deny declines a
    // pending request; access_deny_upgrade declines a parked tier upgrade
    // WITHOUT touching the live grant; access_revoke (from the /all-access
    // list) pulls a live grant. The datepicker's/select's own change events
    // (expiry_date, grant_quality) are ignored.
    const act = payload?.actions?.[0];
    const isApprove = !!act?.action_id?.startsWith('access_approve');
    const isDeny = act?.action_id === 'access_deny';
    const isDenyUpgrade = act?.action_id === 'access_deny_upgrade';
    const isRevoke = act?.action_id === 'access_revoke';
    if (!act || (!isApprove && !isDeny && !isDenyUpgrade && !isRevoke)) {
        return NextResponse.json({ ok: true }); // not one of our buttons — ack and ignore
    }
    const responseUrl = payload.response_url;
    const clicker = payload.user?.id;

    // Authz: the channel is admins-only, so any signed click decides. If
    // SLACK_APPROVER_IDS is set, enforce it as an optional allowlist.
    const allow = (process.env.SLACK_APPROVER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (allow.length && !allow.includes(clicker)) {
        await respond(responseUrl, note("You're not authorized to approve model access. Ask an admin, or use the console."));
        return NextResponse.json({ ok: true });
    }

    // Value is "<requestId>" (tolerate a legacy "<id>:<days>" from older cards).
    const requestId = Number(String(act.value).split(':')[0]);
    if (!Number.isInteger(requestId) || requestId <= 0) {
        await respond(responseUrl, note('This request is no longer valid.'));
        return NextResponse.json({ ok: true });
    }
    const approve = isApprove;
    const byUser = `${payload.user?.username || payload.user?.name || clicker} (Slack)`;

    // Declining an upgrade clears ONLY the parked tier ask — the live grant,
    // its expiry and the gateway override all stay untouched (no sync needed).
    if (isDenyUpgrade) {
        const row = await denyUpgrade(requestId, byUser);
        if (!row) {
            await respond(responseUrl, note('That upgrade was already handled.'));
            return NextResponse.json({ ok: true });
        }
        await respond(responseUrl, {
            replace_original: true,
            text: `🚫 Upgrade declined: ${row.user_email} keeps up to ${row.max_resolution || 'full'} on ${modelLabel(row.model_id)}`,
            blocks: [
                { type: 'header', text: { type: 'plain_text', text: '🚫 Quality upgrade declined', emoji: true } },
                { type: 'section', fields: [
                    { type: 'mrkdwn', text: `*User:*\n${esc(row.user_email)}` },
                    { type: 'mrkdwn', text: `*Model:*\n${esc(modelLabel(row.model_id))}` },
                    { type: 'mrkdwn', text: `*Declined by:*\n${esc(byUser)}` },
                    { type: 'mrkdwn', text: `*Existing access:*\nunchanged (up to ${esc(row.max_resolution || 'full range')})` },
                ] },
            ],
        });
        return NextResponse.json({ ok: true });
    }

    // Grant window = the picked expiry date (end of day, UTC); if untouched, fall
    // back to SLACK_APPROVE_DAYS (default 2).
    let validUntil = null;
    if (approve) {
        const picked = pickedDate(payload);
        const at = picked
            ? Date.parse(`${picked}T23:59:59.000Z`)
            : Date.now() + (Number(process.env.SLACK_APPROVE_DAYS) || 2) * 86400000;
        if (!Number.isFinite(at) || at <= Date.now()) {
            await respond(responseUrl, note('That expiry date is in the past — pick a future date.'));
            return NextResponse.json({ ok: true });
        }
        validUntil = new Date(at).toISOString();
    }

    // The granted quality: the select's pick (options come from our own card,
    // so they're already valid tiers for the model); null keeps the requested tier.
    const quality = approve ? pickedQuality(payload) : null;

    const row = await setRequestStatus(requestId, nextStatus(approve ? 'approve' : 'revoke'), byUser, validUntil, quality);
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

    if (isRevoke) {
        // Redraw the /all-access list in place so the pulled grant drops off.
        let granted = [];
        try { granted = await listActiveGrants(); }
        catch (err) { console.error('[slack] revoke list refresh failed:', err.message); }
        await respond(responseUrl, { ...buildAccessListMessage(granted), replace_original: true });
        return NextResponse.json({ ok: true });
    }

    await respond(responseUrl, outcomeMessage({
        approved: approve, email: row.user_email, model: modelLabel(row.model_id), byUser,
        expiresAt: row.expires_at, maxResolution: row.max_resolution,
    }));
    return NextResponse.json({ ok: true });
}
