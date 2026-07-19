import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    slackMessage, slackConfigured, notifySlackAccessRequested, notifySlackAccessDecided,
    buildAccessRequestedMessage, buildAccessDecidedMessage, buildAccessListMessage,
    buildProjectRequestedMessage, buildProjectDecidedMessage,
} from '../lib/notify/slack.mjs';

function clearUrls() {
    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
}

test('slackMessage builds header + field section, drops empty fields', () => {
    const m = slackMessage('fallback', 'Header', [
        { title: 'User', value: 'u@x.com' },
        { title: 'Note', value: '' },
    ]);
    assert.equal(m.blocks[0].type, 'header');
    assert.equal(m.blocks[0].text.text, 'Header');
    assert.equal(m.blocks[1].type, 'section');
    assert.equal(m.blocks[1].fields.length, 1);
    assert.match(m.blocks[1].fields[0].text, /\*User:\*\nu@x\.com/);
});

test('slackMessage escapes Slack mrkdwn specials in values', () => {
    const m = slackMessage('f', 'H', [{ title: 'Note', value: '<b> & </b>' }]);
    assert.match(m.blocks[1].fields[0].text, /&lt;b&gt; &amp; &lt;\/b&gt;/);
    assert.ok(!m.blocks[1].fields[0].text.includes('<b>'));
});

test('slackMessage adds an actions block only when actions are given', () => {
    const withActions = slackMessage('f', 'H', [{ title: 'A', value: '1' }],
        [{ type: 'button', text: { type: 'plain_text', text: 'Review' }, url: 'https://x/console' }]);
    assert.equal(withActions.blocks[2].type, 'actions');
    assert.equal(withActions.blocks[2].elements[0].url, 'https://x/console');
    assert.equal(slackMessage('f', 'H', [{ title: 'A', value: '1' }]).blocks.length, 2);
});

test('SLACK_MENTION is prepended to the notification text when set', () => {
    process.env.SLACK_MENTION = '<!channel>';
    const m = slackMessage('hello', 'H', [{ title: 'A', value: '1' }]);
    assert.equal(m.text, '<!channel> hello');
    delete process.env.SLACK_MENTION;
});

test('slackConfigured reflects SLACK_WEBHOOK_URL', () => {
    delete process.env.SLACK_WEBHOOK_URL;
    assert.equal(slackConfigured(), false);
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/x';
    assert.equal(slackConfigured(), true);
    delete process.env.SLACK_WEBHOOK_URL;
});

test('buildAccessRequestedMessage: no interactive controls without a signing secret', () => {
    delete process.env.SLACK_SIGNING_SECRET;
    clearUrls();
    const m = buildAccessRequestedMessage({ id: 42, email: 'u@x.com', modelId: 'nano-banana-pro', projectName: 'P' });
    assert.equal(m.blocks.some((b) => b.block_id === 'access_expiry'), false);
    assert.equal(m.blocks.some((b) => b.block_id === 'access_decision'), false);
});

test('buildAccessRequestedMessage: datepicker + single approve + deny when signing secret is set', () => {
    process.env.SLACK_SIGNING_SECRET = 'shhh';
    clearUrls();
    const m = buildAccessRequestedMessage({ id: 42, email: 'u@x.com', modelId: 'nano-banana-pro', projectName: 'P' });
    const expiry = m.blocks.find((b) => b.block_id === 'access_expiry');
    assert.equal(expiry.elements[0].type, 'datepicker');
    assert.equal(expiry.elements[0].action_id, 'expiry_date');
    const els = m.blocks.find((b) => b.block_id === 'access_decision').elements;
    const approves = els.filter((e) => e.action_id?.startsWith('access_approve'));
    assert.equal(approves.length, 1, 'exactly one approve button (custom picker only, no presets)');
    assert.equal(approves[0].action_id, 'access_approve');
    assert.equal(approves[0].value, '42', 'approve carries the bare request id');
    assert.ok(approves[0].confirm, 'approve confirm present');
    assert.equal(els.find((e) => e.action_id === 'access_deny').value, '42');
    // Slack caps an actions block at 5 elements — regressions here 400 at post time.
    for (const b of m.blocks.filter((x) => x.type === 'actions')) {
        assert.ok(b.elements.length <= 5, `actions block ${b.block_id} has ${b.elements.length} elements (max 5)`);
    }
    delete process.env.SLACK_SIGNING_SECRET;
});

test('buildAccessRequestedMessage: upgrade card shows current → wanted and uses the upgrade deny action', () => {
    process.env.SLACK_SIGNING_SECRET = 'shhh';
    clearUrls();
    const m = buildAccessRequestedMessage({
        id: 42, email: 'u@x.com', modelId: 'nano-banana-pro', projectName: 'P',
        maxResolution: '4K', upgradeFrom: '2K',
    });
    assert.match(m.blocks[0].text.text, /upgrade/i);
    assert.ok(m.blocks[1].fields.some((f) => f.text.includes('2K → 4K')), 'quality field shows current → wanted');
    const els = m.blocks.find((b) => b.block_id === 'access_decision').elements;
    assert.equal(els.find((e) => e.action_id === 'access_deny_upgrade').value, '42');
    assert.equal(els.some((e) => e.action_id === 'access_deny'), false, 'plain deny absent on upgrade cards');
    // The quality select is preset to the WANTED tier.
    const select = m.blocks.find((b) => b.block_id === 'access_expiry').elements.find((e) => e.type === 'static_select');
    assert.equal(select.initial_option.value, '4K');
    delete process.env.SLACK_SIGNING_SECRET;
});

test('buildAccessRequestedMessage: plain card keeps the plain deny action', () => {
    process.env.SLACK_SIGNING_SECRET = 'shhh';
    clearUrls();
    const m = buildAccessRequestedMessage({ id: 7, email: 'u@x.com', modelId: 'nano-banana-pro', projectName: 'P', maxResolution: '2K' });
    const els = m.blocks.find((b) => b.block_id === 'access_decision').elements;
    assert.equal(els.find((e) => e.action_id === 'access_deny').value, '7');
    assert.equal(els.some((e) => e.action_id === 'access_deny_upgrade'), false);
    delete process.env.SLACK_SIGNING_SECRET;
});

test('buildProjectRequestedMessage: approve/deny carry the request id behind confirms', () => {
    process.env.SLACK_SIGNING_SECRET = 'shhh';
    clearUrls();
    const m = buildProjectRequestedMessage({ id: 9, email: 'u@x.com', name: 'Marketing Videos', note: 'Q3 push' });
    assert.match(m.blocks[0].text.text, /project request/i);
    assert.ok(m.blocks[1].fields.some((f) => f.text.includes('Marketing Videos')));
    const els = m.blocks.find((b) => b.block_id === 'project_decision').elements;
    const approve = els.find((e) => e.action_id === 'project_approve');
    assert.equal(approve.value, '9');
    assert.ok(approve.confirm, 'approve is behind a confirm dialog');
    assert.equal(els.find((e) => e.action_id === 'project_deny').value, '9');
    // No model-access actions leak onto project cards.
    assert.equal(els.some((e) => String(e.action_id).startsWith('access_')), false);
    delete process.env.SLACK_SIGNING_SECRET;
});

test('buildProjectRequestedMessage: no interactive controls without a signing secret', () => {
    delete process.env.SLACK_SIGNING_SECRET;
    clearUrls();
    const m = buildProjectRequestedMessage({ id: 9, email: 'u@x.com', name: 'P' });
    assert.equal(m.blocks.some((b) => b.block_id === 'project_decision'), false);
});

test('buildProjectDecidedMessage headers reflect the outcome', () => {
    assert.match(buildProjectDecidedMessage({ email: 'u@x.com', name: 'P', status: 'approved' }).blocks[0].text.text, /created/i);
    assert.match(buildProjectDecidedMessage({ email: 'u@x.com', name: 'P', status: 'denied' }).blocks[0].text.text, /declined/i);
});

test('buildAccessListMessage: empty grants → ephemeral note, no revoke buttons', () => {
    const m = buildAccessListMessage([]);
    assert.equal(m.response_type, 'ephemeral');
    assert.match(m.text, /no active/i);
    const buttons = m.blocks.flatMap((b) => (b.accessory ? [b.accessory] : []));
    assert.equal(buttons.length, 0);
});

test('buildAccessListMessage: one section per grant, each with a Revoke button carrying the id', () => {
    process.env.SLACK_SIGNING_SECRET = 'shhh';
    const grants = [
        { id: 7, user_email: 'a@x.com', model_id: 'nano-banana-pro', project_name: 'P', expires_at: null },
        { id: 8, user_email: 'b@x.com', model_id: 'nano-banana-pro', project_id: 3, expires_at: '2099-01-01T00:00:00Z' },
    ];
    const m = buildAccessListMessage(grants);
    assert.match(m.blocks[0].text.text, /2 active/);
    const sections = m.blocks.filter((b) => b.type === 'section');
    assert.equal(sections.length, 2, 'one section per grant');
    assert.equal(sections[0].accessory.action_id, 'access_revoke');
    assert.equal(sections[0].accessory.value, '7');
    assert.equal(sections[1].accessory.value, '8');
    assert.ok(sections[0].accessory.confirm, 'revoke is behind a confirm dialog');
    delete process.env.SLACK_SIGNING_SECRET;
});

test('buildAccessListMessage: no Revoke buttons without a signing secret (read-only)', () => {
    delete process.env.SLACK_SIGNING_SECRET;
    const m = buildAccessListMessage([{ id: 7, user_email: 'a@x.com', model_id: 'nano-banana-pro', expires_at: null }]);
    assert.equal(m.blocks.filter((b) => b.accessory).length, 0);
});

test('buildAccessDecidedMessage headers reflect the outcome', () => {
    assert.match(buildAccessDecidedMessage({ email: 'u@x.com', modelId: 'nano-banana-pro', status: 'approved', expiresAt: null }).blocks[0].text.text, /approved/i);
    assert.match(buildAccessDecidedMessage({ email: 'u@x.com', modelId: 'nano-banana-pro', status: 'revoked' }).blocks[0].text.text, /declined|revoked/i);
});

test('notify functions no-op (never throw) when the webhook is unset', async () => {
    delete process.env.SLACK_WEBHOOK_URL;
    const a = await notifySlackAccessRequested({ id: 1, email: 'u@x.com', modelId: 'nano-banana-pro', projectName: 'P', note: 'hi' });
    assert.equal(a.skipped, true);
    const b = await notifySlackAccessDecided({ email: 'u@x.com', modelId: 'nano-banana-pro', status: 'approved', expiresAt: null });
    assert.equal(b.skipped, true);
});
