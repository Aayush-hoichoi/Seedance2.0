import test from 'node:test';
import assert from 'node:assert/strict';
import { backfillTeamsCards } from '../lib/notify/teamsBackfill.mjs';

// Teams approval cards are posted once, at request time, fire-and-forget — so a
// user's request can never fail because Microsoft is down. The cost was that a
// failed send was PERMANENT: nothing retried, and the request stayed invisible
// to any admin working from Teams rather than the console.
//
// Production carried 10 pending model-access requests and 1 pending budget
// request with no card. One of those was created two minutes AFTER the feature
// deployed — a genuinely lost send, not pre-feature history. This is the retry.

// Minimal stand-in for the neon tagged-template client: returns canned rows in
// call order and records the statements, like tests/gatewaySyncReapproval.
function fakeSql(responses) {
    const calls = [];
    const queue = [...responses];
    const sql = (strings, ...values) => {
        calls.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
        return Promise.resolve(queue.shift() ?? []);
    };
    sql.calls = calls;
    return sql;
}

function deps(overrides = {}) {
    const sent = { access: [], budget: [] };
    return {
        sent,
        opts: {
            isConfigured: () => true,
            loadAccess: async (id) => ({ id, userEmail: 'u@example.com' }),
            sendAccess: async ({ requestId }) => { sent.access.push(requestId); return { sent: 1, total: 1 }; },
            loadBudget: async (id) => ({ id, userEmail: 'u@example.com' }),
            sendBudget: async ({ requestId }) => { sent.budget.push(requestId); return { sent: 1, total: 1 }; },
            ...overrides,
        },
    };
}

test('a pending request with no card gets one', async () => {
    const sql = fakeSql([[{ id: 176 }, { id: 180 }], [{ target_id: 'abc' }]]);
    const { sent, opts } = deps();
    const result = await backfillTeamsCards({ sql, ...opts });

    assert.deepEqual(sent.access, [176, 180]);
    assert.deepEqual(sent.budget, ['abc']);
    assert.deepEqual(result, {
        access: { sent: 2, undelivered: 0 }, budget: { sent: 1, undelivered: 0 }, skipped: false,
    });
});

test('only PENDING requests are swept — a decided one must not resurface', async () => {
    const sql = fakeSql([[], []]);
    const { opts } = deps();
    await backfillTeamsCards({ sql, ...opts });

    const [access, budget] = sql.calls.map((c) => c.text);
    assert.match(access, /status IN \('pending', 'upgrade_pending'\)/);
    assert.match(budget, /NOT EXISTS \(SELECT 1 FROM audit_log d/,
        'a budget request is pending only while it has no decision row');
    assert.match(budget, /budget_request.approved', 'budget_request.denied'/);
});

test('requests that already have a card are excluded, so a sweep never duplicates', async () => {
    const sql = fakeSql([[], []]);
    const { opts } = deps();
    await backfillTeamsCards({ sql, ...opts });

    assert.match(sql.calls[0].text, /NOT EXISTS \(SELECT 1 FROM teams_access_cards c WHERE c.request_id = r.id\)/);
    assert.match(sql.calls[1].text, /NOT EXISTS \(SELECT 1 FROM teams_budget_cards c WHERE c.request_id = a.target_id\)/);
});

test('the sweep is bounded by age and batch size', async () => {
    const sql = fakeSql([[], []]);
    const { opts } = deps();
    await backfillTeamsCards({ sql, maxAgeDays: 7, limit: 5, ...opts });

    for (const call of sql.calls) {
        assert.ok(call.values.includes(7), 'age bound must be bound as a parameter');
        assert.ok(call.values.includes(5), 'batch cap must be bound as a parameter');
        assert.match(call.text, /LIMIT/);
    }
});

test('one failed send does not strand the rest of the batch', async () => {
    const sql = fakeSql([[{ id: 1 }, { id: 2 }, { id: 3 }], []]);
    const { sent, opts } = deps({
        sendAccess: async ({ requestId }) => {
            if (requestId === 2) throw new Error('Teams unreachable');
            sent.access.push(requestId);
            return { sent: 1, total: 1 };
        },
    });
    const saved = console.error;
    console.error = () => {};
    try {
        const result = await backfillTeamsCards({ sql, ...opts });
        assert.deepEqual(sent.access, [1, 3], 'the failure must not abort the sweep');
        assert.deepEqual(result.access, { sent: 2, undelivered: 1 },
            'a throw is undelivered, never counted as sent');
    } finally { console.error = saved; }
});

test('a request decided between the query and the send is skipped, not sent', async () => {
    const sql = fakeSql([[{ id: 9 }], []]);
    const { sent, opts } = deps({ loadAccess: async () => null });
    const result = await backfillTeamsCards({ sql, ...opts });
    assert.deepEqual(sent.access, []);
    assert.deepEqual(result.access, { sent: 0, undelivered: 0 }, 'skipped, not a failed delivery');
});

test('with Teams unconfigured it does no work at all', async () => {
    const sql = fakeSql([[{ id: 1 }], [{ target_id: 'x' }]]);
    const { sent, opts } = deps({ isConfigured: () => false });
    const result = await backfillTeamsCards({ sql, ...opts });

    assert.deepEqual(result, { access: 0, budget: 0, skipped: true });
    assert.deepEqual(sql.calls, [], 'no point walking the tables without credentials');
    assert.deepEqual([...sent.access, ...sent.budget], []);
});

test('no sql client is a no-op rather than a crash in the cron', async () => {
    const { opts } = deps();
    assert.deepEqual(await backfillTeamsCards({ sql: null, ...opts }), { access: 0, budget: 0, skipped: true });
});

// The bug this run exposed in production: the senders swallow their own
// failures by design and return normally, so counting loop iterations reported
// "10 access + 1 budget sent" for a run that delivered NOTHING — the exact
// false-success this sweep exists to correct, reintroduced one layer up.
test('a sender that delivers nothing is counted as undelivered, not sent', async () => {
    const sql = fakeSql([[{ id: 1 }, { id: 2 }], [{ target_id: 'x' }]]);
    const { opts } = deps({
        // What notifyTeams*Requested really returns when no approver resolves.
        sendAccess: async () => ({ sent: 0, total: 1 }),
        sendBudget: async () => null,
    });
    const saved = console.error;
    console.error = () => {};
    try {
        const result = await backfillTeamsCards({ sql, ...opts });
        assert.deepEqual(result.access, { sent: 0, undelivered: 2 });
        assert.deepEqual(result.budget, { sent: 0, undelivered: 1 },
            'a null return means the notifier bailed before sending');
    } finally { console.error = saved; }
});

test('partial delivery counts only the cards that landed', async () => {
    const sql = fakeSql([[{ id: 1 }], []]);
    const { opts } = deps({ sendAccess: async () => ({ sent: 1, total: 3 }) });
    const result = await backfillTeamsCards({ sql, ...opts });
    assert.deepEqual(result.access, { sent: 1, undelivered: 0 },
        'one approver of three reached is still a delivered card');
});
