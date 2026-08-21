// Teams budget-approval cards.
//
// The card is a PROJECTION of audit_log, never a second copy of the decision.
// That is what makes the two surfaces safe to run at once: a card may be
// stale, and acting on a stale one cannot double-decide, because every action
// re-validates against the one-shot guard in decideBudgetRequest. These tests
// pin the parts that are pure — the card contract and the configuration gate.
//
// Approve/Deny are `Action.Execute`, never `Action.OpenUrl`. An Execute action
// is an invoke activity signed by the Teams client and verified before it acts;
// a URL is decided by whoever fetches it, and while these buttons were briefly
// links, Defender Safe Links and preview crawlers decided seven production
// requests within ~1s of delivery. Hence the standing rule pinned below: no
// card URL may point into /api/.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBudgetRequestCard, buildDecidedCard, teamsConfigured, approverIds } from '../lib/notify/teams.mjs';

const AAD_A = '2b436b3a-cf2d-470b-b6ca-817d7c026ca3';
const AAD_B = 'fcb5fba0-8ff1-4a55-9d0e-3c2b7a1e6d94';

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
const inputNodes = (card) => walk(card).filter((n) => String(n.type || '').startsWith('Input.'));

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

// --- the card decides in place, over an authenticated channel ----------------

test('approve and deny are Action.Execute, carrying the request id', () => {
    const card = buildBudgetRequestCard(REQUEST, 'req-1');
    const approve = card.actions.find((a) => a.title === 'Approve');
    const deny = card.actions.find((a) => a.title === 'Deny');
    assert.equal(approve.type, 'Action.Execute');
    assert.equal(approve.verb, 'budget_approve');
    assert.deepEqual(approve.data, { requestId: 'req-1' });
    assert.equal(deny.type, 'Action.Execute');
    assert.equal(deny.verb, 'budget_deny');
});

test('the amount, limit behaviour and note are editable on the card', () => {
    const card = buildBudgetRequestCard(REQUEST, 'req-1');
    const byId = Object.fromEntries(inputNodes(card).map((n) => [n.id, n]));
    assert.equal(byId.approvedAmount.type, 'Input.Number');
    assert.equal(byId.approvedAmount.value, REQUEST.increaseAmount, 'prefilled with what was asked for');
    assert.deepEqual(byId.policy.choices.map((c) => c.value), ['hard', 'soft']);
    assert.equal(byId.reason.type, 'Input.Text');
});

// THE regression guard. Execute actions are safe; URLs are not, because
// everything in a mail/chat stack fetches URLs it finds. /console/* is a page
// behind a session; /api/* is what turned a notification into 7 decisions
// nobody made. No card URL may ever point into the API again.
test('no card URL points at an API route', () => {
    process.env.APP_URL = 'https://app.example';
    for (const card of [
        buildBudgetRequestCard(REQUEST, 'req-1'),
        buildDecidedCard(REQUEST, { status: 'approved', approvedIncrease: 3, decidedBy: 'Rachit' }),
    ]) {
        for (const action of card.actions || []) {
            assert.doesNotMatch(action.url || '', /\/api\//, `${action.title} must not link into the API`);
            if (action.type === 'Action.OpenUrl') assert.doesNotMatch(action.title, /approve|deny/i, 'a decision must never be a link');
        }
    }
});

test('the console link is still there alongside the decision actions', () => {
    process.env.APP_URL = 'https://app.example';
    const card = buildBudgetRequestCard(REQUEST, 'req-1');
    const console_ = card.actions.find((a) => a.type === 'Action.OpenUrl');
    assert.equal(console_.url, 'https://app.example/console/budget-requests');
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
        TEAMS_APP_ID: '', TEAMS_APP_PASSWORD: '', TEAMS_TENANT_ID: '', TEAMS_ADMIN_AAD_IDS: '', ...o,
    });
    set({});
    assert.equal(teamsConfigured(), false, 'unset means inert');
    set({ TEAMS_APP_ID: 'a', TEAMS_APP_PASSWORD: 'b', TEAMS_TENANT_ID: 'c' });
    assert.equal(teamsConfigured(), false, 'no recipients means nothing to send');
    set({ TEAMS_APP_ID: 'a', TEAMS_APP_PASSWORD: 'b', TEAMS_TENANT_ID: 'c', TEAMS_ADMIN_AAD_IDS: AAD_A });
    assert.equal(teamsConfigured(), true);
});

test('approverIds parses a comma list and tolerates spacing and empties', async (t) => {
    const saved = process.env.TEAMS_ADMIN_AAD_IDS;
    t.after(() => { process.env.TEAMS_ADMIN_AAD_IDS = saved; });
    process.env.TEAMS_ADMIN_AAD_IDS = ` ${AAD_A} , ${AAD_B} ,, `;
    assert.deepEqual(approverIds(), [AAD_A, AAD_B]);
});

// An AAD object id is case-sensitive as an address, unlike an email — lowercasing
// it (as the email list did) would hand Microsoft an id it does not recognise.
test('ids are passed through verbatim, never case-folded', async (t) => {
    const saved = process.env.TEAMS_ADMIN_AAD_IDS;
    t.after(() => { process.env.TEAMS_ADMIN_AAD_IDS = saved; });
    const mixed = '2B436b3A-CF2d-470B-b6CA-817d7c026CA3';
    process.env.TEAMS_ADMIN_AAD_IDS = mixed;
    assert.deepEqual(approverIds(), [mixed]);
});

// The failure this exists to prevent: recipients configured under a variable
// nothing reads any more. Credentials present with an empty list is a BROKEN
// config, not a disabled feature, and must be distinguishable from "Teams off".
test('credentials with no recipients reads as misconfigured, not as switched off', async (t) => {
    const { teamsMisconfigured } = await import('../lib/teams/bot.mjs');
    const saved = { ...process.env };
    t.after(() => { process.env = saved; });
    const set = (o) => Object.assign(process.env, {
        TEAMS_APP_ID: '', TEAMS_APP_PASSWORD: '', TEAMS_TENANT_ID: '', TEAMS_ADMIN_AAD_IDS: '', ...o,
    });

    set({});
    assert.equal(teamsMisconfigured(), false, 'nothing configured at all is simply off');
    set({ TEAMS_APP_ID: 'a', TEAMS_APP_PASSWORD: 'b', TEAMS_TENANT_ID: 'c' });
    assert.equal(teamsMisconfigured(), true, 'a bot with nobody to notify is broken and must say so');
    set({ TEAMS_APP_ID: 'a', TEAMS_APP_PASSWORD: 'b', TEAMS_TENANT_ID: 'c', TEAMS_ADMIN_AAD_IDS: AAD_A });
    assert.equal(teamsMisconfigured(), false);
});

// Best-effort delivery used to make every failure look like a success from the
// outside, which is how a recipient can stop receiving cards with nothing in the
// logs. reportDelivery counts only what actually landed and names what did not.
test('reportDelivery counts only delivered cards and names every failure', async (t) => {
    const { reportDelivery } = await import('../lib/teams/bot.mjs');
    const errors = [];
    const realError = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    t.after(() => { console.error = realError; });

    const sent = reportDelivery('budget request', [AAD_A, AAD_B], [
        { status: 'fulfilled', value: 'activity-1' },
        { status: 'rejected', reason: new Error('bot not installed') },
    ]);
    assert.equal(sent, 1, 'one of two landed');
    assert.ok(errors.some((e) => e.includes(AAD_B) && e.includes('bot not installed')), 'the failing id is named');

    errors.length = 0;
    assert.equal(reportDelivery('budget request', [AAD_A], [{ status: 'rejected', reason: new Error('x') }]), 0);
    assert.ok(errors.some((e) => /NO admin received a card/.test(e)), 'a total blackout is called out on its own');
});

// A sparse request must still produce a usable card: the recipient may be the
// only person who can unblock the user, and a card that fails to render because
// a field was null helps nobody.
test('a request missing optional fields still renders an actionable card', () => {
    const card = buildBudgetRequestCard(
        { projectName: 'P', userEmail: 'u@x.com', modelName: 'M', increaseAmount: 10 }, 'req-1',
    );
    assert.ok(Array.isArray(card.actions));
    assert.ok(card.actions.some((a) => a.type === 'Action.Execute' && a.verb === 'budget_approve'));
    assert.equal(inputNodes(card).find((n) => n.id === 'approvedAmount').value, 10);
});
