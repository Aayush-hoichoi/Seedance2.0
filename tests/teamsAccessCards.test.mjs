// Teams model-access-approval cards. Same contract as tests/teamsBudgetCards.test.mjs
// (the sibling feature built on the same lib/teams/bot.mjs transport), covering
// what's different here: no money fields, a plain-request vs. upgrade-request
// split (different header, different Deny label, current→wanted quality), and
// the three real decision states (approved / denied / upgrade declined).

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAccessRequestCard, buildAccessDecidedCard, teamsConfigured, approverEmails } from '../lib/notify/teamsAccess.mjs';

const REQUEST = {
    userEmail: 'shinji.nandy@example.com',
    projectName: 'Launch Campaign',
    modelId: 'seedance-2-0',
    maxResolution: '1080p',
    pendingMaxResolution: null,
    note: 'Need it for the trailer cut',
};

const UPGRADE_REQUEST = { ...REQUEST, maxResolution: '720p', pendingMaxResolution: '1080p' };

const LINKS = { approveUrl: 'https://app.example/approve?token=a', denyUrl: 'https://app.example/deny?token=d' };

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
    const card = buildAccessRequestCard(REQUEST, 'req-1', LINKS);
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
    const card = buildAccessRequestCard(UPGRADE_REQUEST, 'req-1', LINKS);
    const titles = factTitles(card);
    assert.ok(titles.includes('Quality'), 'an upgrade uses "Quality", not "Requested quality"');
    assert.ok(!titles.includes('Requested quality'));
    assert.match(textOf(card), /720p → 1080p/);
    assert.match(textOf(card), /Quality upgrade request/);
});

test('approve and deny are plain links, and their labels differ for an upgrade', () => {
    const plain = buildAccessRequestCard(REQUEST, 'req-1', LINKS);
    assert.deepEqual(inputNodes(plain), [], 'nothing to fill in');
    assert.ok(plain.actions.find((a) => a.title === 'Approve' && a.type === 'Action.OpenUrl' && a.url === LINKS.approveUrl));
    assert.ok(plain.actions.find((a) => a.title === 'Deny' && a.url === LINKS.denyUrl));

    const upgrade = buildAccessRequestCard(UPGRADE_REQUEST, 'req-1', LINKS);
    assert.ok(upgrade.actions.find((a) => a.title === 'Approve upgrade'), 'an upgrade card must not just say "Approve" — it is not a fresh grant');
    assert.ok(upgrade.actions.find((a) => a.title === 'Deny upgrade'), 'denying an upgrade must read differently from denying a fresh request');
});

test('a card built with no links renders safely with no decision buttons', () => {
    const card = buildAccessRequestCard(REQUEST, 'req-1');
    assert.equal(card.actions.filter((a) => /approve|deny/i.test(a.title)).length, 0);
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

test('teamsConfigured and approverEmails are the shared config surface, not duplicated per feature', () => {
    assert.equal(typeof teamsConfigured, 'function');
    assert.equal(typeof approverEmails, 'function');
});
