// Teams budget-approval cards.
//
// The card is a PROJECTION of audit_log, never a second copy of the decision.
// That is what makes the two surfaces safe to run at once: a card may be
// stale, and acting on a stale one cannot double-decide, because every action
// re-validates against the one-shot guard in decideBudgetRequest. These tests
// pin the parts that are pure — the card contract and the configuration gate.
//
// Approve/Deny are plain `Action.OpenUrl` links, not `Action.Execute` — there
// is no inbound Bot Framework endpoint in this design, so a card must never
// depend on one to be actionable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBudgetRequestCard, buildDecidedCard, teamsConfigured, approverEmails } from '../lib/notify/teams.mjs';

const REQUEST = {
    projectName: 'Launch Campaign',
    userName: 'Swapnanil Manna',
    userEmail: 'swapnanil@example.com',
    modelName: 'Seedance 2.0',
    quality: '1080p',
    spent: 12.4,
    currentLimit: 25,
    increaseAmount: 5,
    reason: 'Final launch renders',
};

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

// --- the card carries what an admin needs to judge the amount ----------------
//
// Deciding from a phone means deciding without the console's usage history, so
// the two numbers that make an amount judgeable — what they have spent and what
// they were allotted — have to be on the card itself.

test('the request card shows user, project, model, spend and total allotted', () => {
    const card = buildBudgetRequestCard(REQUEST, 'req-1', LINKS);
    const titles = factTitles(card);
    for (const t of ['User', 'Project', 'Model', 'Spent this month', 'Total allotted']) {
        assert.ok(titles.includes(t), `card must show "${t}"`);
    }
    const text = textOf(card);
    assert.match(text, /Swapnanil Manna/);
    assert.match(text, /Launch Campaign/);
    assert.match(text, /Seedance 2\.0/);
    assert.match(text, /\$5\.00/, 'the requested amount');
    assert.match(text, /\$12\.40/, 'spent this month');
    assert.match(text, /\$25\.00/, 'total allotted');
    assert.match(text, /Final launch renders/, 'the reason');
});

test('an absent cap reads as "No personal limit", not $0.00', () => {
    const card = buildBudgetRequestCard({ ...REQUEST, currentLimit: null }, 'req-1', LINKS);
    assert.match(textOf(card), /No personal limit/);
    assert.doesNotMatch(textOf(card), /Total allotted \| \$0\.00/);
});

// --- deciding is a one-tap link, not a form ----------------------------------

test('approve and deny are plain links, not embedded form inputs', () => {
    const card = buildBudgetRequestCard(REQUEST, 'req-1', LINKS);
    assert.deepEqual(inputNodes(card), [], 'nothing to fill in — no Action.Execute round-trip exists to receive it');
    const approve = card.actions.find((a) => a.title === 'Approve');
    const deny = card.actions.find((a) => a.title === 'Deny');
    assert.equal(approve.type, 'Action.OpenUrl');
    assert.equal(approve.url, LINKS.approveUrl);
    assert.equal(deny.type, 'Action.OpenUrl');
    assert.equal(deny.url, LINKS.denyUrl);
});

test('a card built with no links renders safely with no decision buttons', () => {
    const card = buildBudgetRequestCard(REQUEST, 'req-1');
    assert.equal(card.actions.filter((a) => a.title === 'Approve' || a.title === 'Deny').length, 0);
});

// --- the decided card is terminal --------------------------------------------

test('a decided card carries no inputs and no decision actions', () => {
    const card = buildDecidedCard(REQUEST, { status: 'approved', approvedIncrease: 3, decidedBy: 'Rachit' });
    assert.deepEqual(inputNodes(card), [], 'nothing left to edit');
    assert.deepEqual((card.actions || []).filter((a) => a.title === 'Approve' || a.title === 'Deny'), [], 'nothing left to tap');
    assert.match(textOf(card), /Budget approved/);
    assert.match(textOf(card), /\$3\.00/);
    assert.match(textOf(card), /Rachit/, 'who decided it');
});

test('an adjusted approval shows both numbers, so a shortfall is never silent', () => {
    const card = buildDecidedCard(REQUEST, {
        status: 'approved', approvedIncrease: 3, requestedIncrease: 5, amountAdjusted: true, decidedBy: 'Rachit',
    });
    const text = textOf(card);
    assert.match(text, /\$3\.00/, 'what was granted');
    assert.match(text, /\$5\.00/, 'what was asked for');
});

test('a denial reads as denied and still shows the context', () => {
    const card = buildDecidedCard(REQUEST, { status: 'denied', decidedBy: 'Rachit', reason: 'Not this cycle' });
    const text = textOf(card);
    assert.match(text, /denied/i);
    assert.match(text, /Not this cycle/);
    assert.ok(factTitles(card).includes('Spent this month'), 'context survives the decision');
});

// --- configuration is a hard gate -------------------------------------------
//
// Every entry point checks teamsConfigured() first: with the vars unset the
// feature must be inert, not half-live. Recipients are emails, not AAD object
// ids — those are resolved via Graph at send time, not configured by hand.

test('teamsConfigured requires all four values', async (t) => {
    const saved = { ...process.env };
    t.after(() => { process.env = saved; });
    const set = (o) => Object.assign(process.env, {
        TEAMS_APP_ID: '', TEAMS_APP_PASSWORD: '', TEAMS_TENANT_ID: '', TEAMS_ADMIN_EMAILS: '', ...o,
    });
    set({});
    assert.equal(teamsConfigured(), false, 'unset means inert');
    set({ TEAMS_APP_ID: 'a', TEAMS_APP_PASSWORD: 'b', TEAMS_TENANT_ID: 'c' });
    assert.equal(teamsConfigured(), false, 'no recipients means nothing to send');
    set({ TEAMS_APP_ID: 'a', TEAMS_APP_PASSWORD: 'b', TEAMS_TENANT_ID: 'c', TEAMS_ADMIN_EMAILS: 'mandar@hoichoi.tv' });
    assert.equal(teamsConfigured(), true);
});

test('approverEmails parses a comma list, tolerates spacing, and lowercases', async (t) => {
    const saved = process.env.TEAMS_ADMIN_EMAILS;
    t.after(() => { process.env.TEAMS_ADMIN_EMAILS = saved; });
    process.env.TEAMS_ADMIN_EMAILS = ' Mandar@Hoichoi.tv , aayush@hoichoi.tv ,, ';
    assert.deepEqual(approverEmails(), ['mandar@hoichoi.tv', 'aayush@hoichoi.tv']);
});
