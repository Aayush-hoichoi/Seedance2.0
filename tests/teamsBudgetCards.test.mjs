// Teams budget-approval cards.
//
// The card is a PROJECTION of audit_log, never a second copy of the decision.
// That is what makes the two surfaces safe to run at once: a card may be stale,
// and acting on a stale one cannot double-decide, because every action
// re-validates against the one-shot guard in decideBudgetRequest. These tests
// pin the parts that are pure — the card contract — plus the identity gate,
// which is the only thing between a valid Teams token and someone else's
// approval rights.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBudgetRequestCard, buildDecidedCard, teamsConfigured, approverIds } from '../lib/notify/teams.mjs';

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
const inputIds = (card) => walk(card).filter((n) => String(n.type || '').startsWith('Input.')).map((n) => n.id);
const verbs = (card) => (card.actions || []).map((a) => a.verb).filter(Boolean);

// --- the card carries what an admin needs to judge the amount ----------------
//
// Deciding from a phone means deciding without the console's usage history, so
// the two numbers that make an amount judgeable — what they have spent and what
// they were allotted — have to be on the card itself.

test('the request card shows user, project, model, spend and total allotted', () => {
    const card = buildBudgetRequestCard(REQUEST, 'req-1');
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
    const card = buildBudgetRequestCard({ ...REQUEST, currentLimit: null }, 'req-1');
    assert.match(textOf(card), /No personal limit/);
    assert.doesNotMatch(textOf(card), /Total allotted \| \$0\.00/);
});

test('the amount is editable and prefilled with what was requested', () => {
    const card = buildBudgetRequestCard(REQUEST, 'req-1');
    const amount = walk(card).find((n) => n.id === 'approvedAmount');
    assert.equal(amount.type, 'Input.Number');
    assert.equal(amount.value, 5, 'prefilled with the request');
    assert.equal(amount.min, 0.01, 'zero or negative is not a decision');
    assert.deepEqual(inputIds(card).sort(), ['approvedAmount', 'policy', 'reason']);
});

test('actions use Action.Execute so the card can be replaced after deciding', () => {
    const card = buildBudgetRequestCard(REQUEST, 'req-1');
    const acting = (card.actions || []).filter((a) => a.verb);
    assert.deepEqual(verbs(card).sort(), ['budget_approve', 'budget_deny']);
    for (const a of acting) {
        assert.equal(a.type, 'Action.Execute', 'Action.Submit cannot return a replacement card');
        assert.equal(a.data.requestId, 'req-1', 'the target rides the action, not user input');
    }
});

// --- the decided card is terminal --------------------------------------------

test('a decided card carries no inputs and no decision actions', () => {
    const card = buildDecidedCard(REQUEST, { status: 'approved', approvedIncrease: 3, decidedBy: 'Rachit' });
    assert.deepEqual(inputIds(card), [], 'nothing left to edit');
    assert.deepEqual(verbs(card), [], 'nothing left to tap');
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
// feature must be inert, not half-live.

test('teamsConfigured requires all four values', async (t) => {
    const saved = { ...process.env };
    t.after(() => { process.env = saved; });
    const set = (o) => Object.assign(process.env, {
        TEAMS_APP_ID: '', TEAMS_APP_PASSWORD: '', TEAMS_TENANT_ID: '', TEAMS_ADMIN_AAD_IDS: '', ...o,
    });
    set({});
    assert.equal(teamsConfigured(), false, 'unset means inert');
    set({ TEAMS_APP_ID: 'a', TEAMS_APP_PASSWORD: 'b', TEAMS_TENANT_ID: 'c' });
    assert.equal(teamsConfigured(), false, 'no recipients means nothing to send');
    set({ TEAMS_APP_ID: 'a', TEAMS_APP_PASSWORD: 'b', TEAMS_TENANT_ID: 'c', TEAMS_ADMIN_AAD_IDS: 'id-1' });
    assert.equal(teamsConfigured(), true);
});

test('approverIds parses a comma list and tolerates spacing', async (t) => {
    const saved = process.env.TEAMS_ADMIN_AAD_IDS;
    t.after(() => { process.env.TEAMS_ADMIN_AAD_IDS = saved; });
    process.env.TEAMS_ADMIN_AAD_IDS = ' id-1 , id-2 ,, ';
    assert.deepEqual(approverIds(), ['id-1', 'id-2']);
});
