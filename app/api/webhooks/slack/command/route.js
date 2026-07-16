// Slack slash-command handler for `/all-access` — lists every active model-access
// grant with a Revoke button. Public (matches the /api/webhooks(.*) middleware
// allowlist); authenticated by Slack's request signature.
//
// Configure in the Slack app under Slash Commands with Request URL:
//   https://<app>/api/webhooks/slack/command
//
//   SLACK_SIGNING_SECRET  the Slack app's signing secret (Basic Information)
//   SLACK_APPROVER_IDS    optional: comma-separated member ids allowed to run it
//                         (the channel is admins-only, so unset = any admin may)

import { NextResponse } from 'next/server';
import { verifySlackSignature } from '../../../../../lib/slack/verify.mjs';
import { listActiveGrants } from '../../../../../lib/access/db.js';
import { buildAccessListMessage } from '../../../../../lib/notify/slack.mjs';

export const runtime = 'nodejs';

export async function POST(request) {
    const rawBody = await request.text();
    const ok = verifySlackSignature({
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        signature: request.headers.get('x-slack-signature'),
        timestamp: request.headers.get('x-slack-request-timestamp'),
        rawBody,
    });
    if (!ok) return NextResponse.json({ error: 'bad signature' }, { status: 401 });

    const form = new URLSearchParams(rawBody);
    const allow = (process.env.SLACK_APPROVER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (allow.length && !allow.includes(form.get('user_id'))) {
        return NextResponse.json({ response_type: 'ephemeral', text: "You're not authorized to view model access." });
    }

    let granted = [];
    try {
        granted = await listActiveGrants();
    } catch (err) {
        console.error('[slack] /all-access list failed:', err.message);
        return NextResponse.json({ response_type: 'ephemeral', text: 'Could not load model access right now — try again.' });
    }
    return NextResponse.json(buildAccessListMessage(granted));
}
