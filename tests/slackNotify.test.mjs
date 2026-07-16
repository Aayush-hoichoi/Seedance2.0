import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    slackMessage, slackConfigured, notifySlackAccessRequested, notifySlackAccessDecided,
} from '../lib/notify/slack.mjs';

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

test('slackMessage adds a link button only when a url is given', () => {
    const withBtn = slackMessage('f', 'H', [{ title: 'A', value: '1' }], 'https://x/console');
    assert.equal(withBtn.blocks[2].type, 'actions');
    assert.equal(withBtn.blocks[2].elements[0].url, 'https://x/console');
    const noBtn = slackMessage('f', 'H', [{ title: 'A', value: '1' }]);
    assert.equal(noBtn.blocks.length, 2);
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

test('notify functions no-op (never throw) when the webhook is unset', async () => {
    delete process.env.SLACK_WEBHOOK_URL;
    const a = await notifySlackAccessRequested({ email: 'u@x.com', modelId: 'nano-banana-pro', projectName: 'P', note: 'hi' });
    assert.equal(a.skipped, true);
    const b = await notifySlackAccessDecided({ email: 'u@x.com', modelId: 'nano-banana-pro', status: 'approved', expiresAt: null });
    assert.equal(b.skipped, true);
});
