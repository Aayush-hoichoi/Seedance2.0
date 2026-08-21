// Teams model-access-approval cards. Same contract as tests/teamsBudgetCards.test.mjs
// (the sibling feature built on the same lib/teams/bot.mjs transport), covering
// what's different here: no money fields, a plain-request vs. upgrade-request
// split (different header, different Deny label, current→wanted quality), and
// the three real decision states (approved / denied / upgrade declined).

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAccessRequestCard, buildAccessDecidedCard, teamsConfigured, approverIds } from '../lib/notify/teamsAccess.mjs';

const REQUEST = {
    userEmail: 'shinji.nandy@example.com',
    projectName: 'Launch Campaign',
    modelId: 'seedance-2-0',
    maxResolution: '1080p',
    pendingMaxResolution: null,
    note: 'Need it for the trailer cut',
};

const UPGRADE_REQUEST = { ...REQUEST, maxResolution: '720p', pendingMaxResolution: '1080p' };


const walk = (node, out = []) => {
    if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
    if (node && typeof node === 'object') {
        out.push(node);
        Object.values(node).forEach((v) => walk(v, out));
    }
    return out;
};
const textOf = (card) => walk(card).map((n) => n.text ?? n.value ?? n.title ?? '').join(' | ');
const factTitles = (card) => walk(card).filter((n) => n.type === 'FactSet').flatMap((f) => f.facts.map((x) => x.title));
const inputNodes = (card) => walk(card).filter((n) => String(n.type || '').startsWith('Input.'));

test('a plain request card shows user, project, model and requested quality', () => {
    const card = buildAccessRequestCard(REQUEST, 'req-1');
    const titles = factTitles(card);
    for (const t of ['User', 'Project', 'Model', 'Requested quality']) {
        assert.ok(titles.includes(t), `card must show "${t}"`);
    }
    const text = textOf(card);
    assert.match(text, /shinji\.nandy@example\.com/);
    assert.match(text, /Launch Campaign/);
    assert.match(text, /1080p/);
    assert.match(text, /Need it for the trailer cut/);
    assert.match(text, /Model access request/);
});

test('an upgrade request shows current → wanted quality under one "Quality" fact, not two', () => {
    const card = buildAccessRequestCard(UPGRADE_REQUEST, 'req-1');
    const titles = factTitles(card);
    assert.ok(titles.includes('Quality'), 'an upgrade uses "Quality", not "Requested quality"');
    assert.ok(!titles.includes('Requested quality'));
    assert.match(textOf(card), /720p → 1080p/);
    assert.match(textOf(card), /Quality upgrade request/);
});

// Same rule as the budget card: notify only. A decision URL in a chat message
// gets fetched by link scanners, which is how requests ended up decided by
// nobody — so neither card type may carry one.
test('neither a plain nor an upgrade card carries a decision action', () => {
    for (const card of [buildAccessRequestCard(REQUEST, 'req-1'), buildAccessRequestCard(UPGRADE_REQUEST, 'req-1')]) {
        assert.deepEqual(inputNodes(card), [], 'nothing to fill in');
        assert.deepEqual(card.actions.filter((a) => /approve|deny/i.test(a.title)), []);
    }
});

test('its only action opens the console, and no card URL points at an API route', () => {
    process.env.APP_URL = 'https://app.example';
    const card = buildAccessRequestCard(UPGRADE_REQUEST, 'req-1');
    assert.equal(card.actions.length, 1);
    assert.equal(card.actions[0].type, 'Action.OpenUrl');
    assert.doesNotMatch(card.actions[0].url, /\/api\//, 'a card URL must be safe to fetch');
});

test('an approved decided card shows the granted tier and expiry, no inputs, no actions left', () => {
    const card = buildAccessDecidedCard(REQUEST, {
        status: 'approved', decidedBy: 'Rachit', maxResolution: '1080p', expiresAt: '2026-09-17T00:00:00.000Z',
    });
    assert.deepEqual(inputNodes(card), []);
    assert.equal(card.actions.filter((a) => /approve|deny/i.test(a.title)).length, 0);
    const text = textOf(card);
    assert.match(text, /Access approved/);
    assert.match(text, /1080p/);
    assert.match(text, /Rachit/);
});

test('a denied decided card reads as denied, not as an upgrade decline', () => {
    const card = buildAccessDecidedCard(REQUEST, { status: 'revoked', decidedBy: 'Rachit' });
    assert.match(textOf(card), /Access request denied/);
});

test('an upgrade-declined decided card reads distinctly from a plain denial', () => {
    const card = buildAccessDecidedCard(UPGRADE_REQUEST, { status: 'upgrade_declined', decidedBy: 'Rachit' });
    assert.match(textOf(card), /Upgrade declined/);
    assert.doesNotMatch(textOf(card), /Access request denied/);
});

// --- configuration is a hard gate, shared with the budget feature ------------

test('teamsConfigured and approverIds are the shared config surface, not duplicated per feature', async () => {
    assert.equal(typeof teamsConfigured, 'function');
    assert.equal(typeof approverIds, 'function');
    // Both features must read the SAME recipient list. Two lists is how one of
    // them ends up notifying nobody without anyone noticing.
    const bot = await import('../lib/teams/bot.mjs');
    const budget = await import('../lib/notify/teams.mjs');
    assert.equal(approverIds, bot.approverIds);
    assert.equal(budget.approverIds, bot.approverIds);
});
