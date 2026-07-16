import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    slackMessage, slackConfigured, notifySlackAccessRequested, notifySlackAccessDecided,
    buildAccessRequestedMessage, buildAccessDecidedMessage,
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

test('buildAccessRequestedMessage: datepicker + preset/custom approve + deny when signing secret is set', () => {
    process.env.SLACK_SIGNING_SECRET = 'shhh';
    clearUrls();
    const m = buildAccessRequestedMessage({ id: 42, email: 'u@x.com', modelId: 'nano-banana-pro', projectName: 'P' });
    const expiry = m.blocks.find((b) => b.block_id === 'access_expiry');
    assert.equal(expiry.elements[0].type, 'datepicker');
    assert.equal(expiry.elements[0].action_id, 'expiry_date');
    const els = m.blocks.find((b) => b.block_id === 'access_decision').elements;
    const approves = els.filter((e) => e.action_id?.startsWith('access_approve'));
    const approveVals = approves.map((e) => e.value);
    assert.ok(['42:7', '42:30', '42:90', '42:custom'].every((v) => approveVals.includes(v)), 'presets + custom present');
    const ids = approves.map((e) => e.action_id);
    assert.equal(new Set(ids).size, ids.length, 'approve action_ids are unique within the block');
    assert.equal(els.find((e) => e.action_id === 'access_deny').value, '42');
    assert.ok(approves.every((e) => e.confirm), 'approve confirms present');
    // Slack caps an actions block at 5 elements — regressions here 400 at post time.
    for (const b of m.blocks.filter((x) => x.type === 'actions')) {
        assert.ok(b.elements.length <= 5, `actions block ${b.block_id} has ${b.elements.length} elements (max 5)`);
    }
    delete process.env.SLACK_SIGNING_SECRET;
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
