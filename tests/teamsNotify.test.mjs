import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    cardMessage, teamsConfigured, notifyTeamsAccessRequested, notifyTeamsAccessDecided,
} from '../lib/notify/teams.mjs';

test('cardMessage wraps an Adaptive Card in the Teams message envelope', () => {
    const m = cardMessage('Hello', [{ title: 'User', value: 'u@x.com' }]);
    assert.equal(m.type, 'message');
    assert.equal(m.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
    const card = m.attachments[0].content;
    assert.equal(card.type, 'AdaptiveCard');
    assert.equal(card.body[0].text, 'Hello');
    assert.equal(card.body[1].type, 'FactSet');
    assert.deepEqual(card.body[1].facts, [{ title: 'User', value: 'u@x.com' }]);
});

test('cardMessage drops facts with empty/nullish values', () => {
    const m = cardMessage('T', [
        { title: 'A', value: 'keep' },
        { title: 'B', value: '' },
        { title: 'C', value: null },
        { title: 'D', value: undefined },
    ]);
    const facts = m.attachments[0].content.body[1].facts;
    assert.deepEqual(facts, [{ title: 'A', value: 'keep' }]);
});

test('teamsConfigured reflects TEAMS_WEBHOOK_URL', () => {
    delete process.env.TEAMS_WEBHOOK_URL;
    assert.equal(teamsConfigured(), false);
    process.env.TEAMS_WEBHOOK_URL = 'https://example.com/hook';
    assert.equal(teamsConfigured(), true);
    delete process.env.TEAMS_WEBHOOK_URL;
});

test('notify functions no-op (never throw) when the webhook is unset', async () => {
    delete process.env.TEAMS_WEBHOOK_URL;
    const a = await notifyTeamsAccessRequested({ email: 'u@x.com', modelId: 'nano-banana-pro', projectName: 'P', note: 'hi' });
    assert.equal(a.ok, false);
    assert.equal(a.skipped, true);
    const b = await notifyTeamsAccessDecided({ email: 'u@x.com', modelId: 'nano-banana-pro', status: 'approved', expiresAt: null });
    assert.equal(b.ok, false);
    assert.equal(b.skipped, true);
});
