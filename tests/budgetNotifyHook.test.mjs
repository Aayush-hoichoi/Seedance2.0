// The seam between "budget request recorded" and "budget card sent".
//
// A card that never arrives looks IDENTICAL whether the notifier is broken, the
// hook was never wired, or the request simply went to a deployment that has no
// Teams code. Only the last of those is not a bug, and none of them are visible
// from the console — the entry appears either way. So the wiring gets a test
// rather than a manual check.
//
// The hook is injected rather than imported so this module stays network-free:
// asserting it is CALLED, with the right shape, is the part that can silently
// regress.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBudgetRequestRouteHandlers, createBudgetDecisionRouteHandler } from '../lib/http/budgetRequestHandlers.mjs';

const USER = { userId: 'user-1', email: 'requester@example.com', name: 'Requester' };
const ADMIN = { userId: 'user-admin', email: 'admin@example.com', role: 'admin' };
const CREATED = {
    id: 'req-abc',
    request: { projectName: 'test4', userName: 'Requester', increaseAmount: 2, spent: 0, currentLimit: 5 },
};

const post = (body) => new Request('http://local/api/budget-requests', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('creating a request invokes onCreated with the id and the card payload', async () => {
    const seen = [];
    const handlers = createBudgetRequestRouteHandlers({
        authenticate: async () => USER,
        loadContext: async () => ({}),
        createRequest: async () => CREATED,
        onCreated: async (result) => { seen.push(result); },
    });

    const res = await handlers.POST(post({ projectId: 1, modelId: '*', quality: 'high', increaseAmount: 2 }));
    assert.equal(res.status, 201);
    assert.equal(seen.length, 1, 'the notifier must be reached — a missing call is an invisible failure');
    assert.equal(seen[0].id, 'req-abc', 'the card needs the request id to be actionable');
    // Everything the card renders comes from this payload; an empty one would
    // send a card with no user, project or amount on it.
    assert.equal(seen[0].request.increaseAmount, 2);
    assert.equal(seen[0].request.projectName, 'test4');
});

test('a failing notifier never turns a recorded request into an error', async () => {
    const handlers = createBudgetRequestRouteHandlers({
        authenticate: async () => USER,
        loadContext: async () => ({}),
        createRequest: async () => CREATED,
        onCreated: async () => { throw new Error('Teams is down'); },
    });

    const res = await handlers.POST(post({ projectId: 1, modelId: '*', quality: 'high', increaseAmount: 2 }));
    // The request is already committed by this point. Surfacing a notification
    // failure would tell the user their request failed when it did not — and
    // they would submit it again.
    assert.equal(res.status, 201, 'the request stands even when the card does not');
    assert.equal((await res.json()).id, 'req-abc');
});

test('no notifier configured is a supported state, not a crash', async () => {
    const handlers = createBudgetRequestRouteHandlers({
        authenticate: async () => USER,
        loadContext: async () => ({}),
        createRequest: async () => CREATED,
        // onCreated omitted entirely — the shape before Teams existed.
    });
    assert.equal((await handlers.POST(post({ projectId: 1, increaseAmount: 2 }))).status, 201);
});

// --- the decision side, which keeps the card in step with the console --------

test('deciding invokes onDecided so the Teams cards stop showing "pending"', async () => {
    const seen = [];
    const handler = createBudgetDecisionRouteHandler({
        authenticate: async () => ADMIN,
        canReview: () => true,
        decideRequest: async () => ({ ok: true, status: 'approved', approvedIncrease: 1, limit: 6 }),
        onDecided: async (info) => { seen.push(info); },
    });

    const res = await handler(post({ approvedAmount: 1, policy: 'hard' }), {
        params: Promise.resolve({ id: 'req-abc', action: 'approve' }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1, 'without this the card sits pending forever on a settled request');
    assert.equal(seen[0].id, 'req-abc');
    assert.equal(seen[0].action, 'approve');
    assert.equal(seen[0].admin.email, 'admin@example.com', 'the card names who decided');
    assert.equal(seen[0].decision.approvedIncrease, 1, 'and the amount actually granted');
});

test('a REJECTED decision never touches the cards', async () => {
    const seen = [];
    const handler = createBudgetDecisionRouteHandler({
        authenticate: async () => ADMIN,
        canReview: () => true,
        decideRequest: async () => ({ error: 'decided' }),
        onDecided: async (info) => { seen.push(info); },
    });

    const res = await handler(post({}), { params: Promise.resolve({ id: 'req-abc', action: 'approve' }) });
    assert.equal(res.status, 409);
    assert.equal(seen.length, 0, 'rewriting cards for a decision that did not happen would be a lie');
});

test('a failing card update never undoes a committed decision', async () => {
    const handler = createBudgetDecisionRouteHandler({
        authenticate: async () => ADMIN,
        canReview: () => true,
        decideRequest: async () => ({ ok: true, status: 'approved', approvedIncrease: 1 }),
        onDecided: async () => { throw new Error('Teams is down'); },
    });

    const res = await handler(post({ approvedAmount: 1 }), {
        params: Promise.resolve({ id: 'req-abc', action: 'approve' }),
    });
    // The quota has already moved. A stale card is cosmetic; a 500 here would
    // make an admin re-approve a request that already succeeded.
    assert.equal(res.status, 200, 'the decision stands even when the card cannot be updated');
});
