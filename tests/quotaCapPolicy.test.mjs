import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { changeQuotaCapSafely } from '../lib/gateway/db.js';
import { resolvePolicyEdit } from '../lib/gateway/quota.mjs';

const admin = { userId: 'user-admin', email: 'admin@example.com' };

function compile(strings, values) {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1]}`;
    return { text, values };
}

// Adapts PGlite to the small Neon tagged-query surface used by production
// (same shim as quotaRescope.test.mjs).
function neonLike(db) {
    function sql(strings, ...values) {
        const query = compile(strings, values);
        const token = {
            async execute(client = db) {
                return (await client.query(query.text, query.values)).rows;
            },
            then(onFulfilled, onRejected) {
                return token.execute().then(onFulfilled, onRejected);
            },
        };
        return token;
    }
    sql.transaction = (statements) => db.transaction(async (tx) => {
        const results = [];
        for (const statement of statements) results.push(await statement.execute(tx));
        return results;
    });
    return sql;
}

// The overall project budget: everyone, all models, USD, lifetime.
async function overallCapDb() {
    const db = new PGlite();
    await db.exec(`
        CREATE TABLE quotas (
            id serial PRIMARY KEY, project_id integer, user_id text, model_id text,
            type text NOT NULL, "window" text NOT NULL, hard_limit numeric NOT NULL,
            policy text NOT NULL DEFAULT 'hard', soft_overage_pct numeric NOT NULL DEFAULT 5,
            alert_thresholds integer[] NOT NULL DEFAULT ARRAY[80,90,100],
            created_by text, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
        );
        CREATE TABLE billing_events (
            id serial PRIMARY KEY, event_type text NOT NULL, generation_id text,
            project_id integer, user_id text, model_id text,
            cost_usd numeric, est_cost_usd numeric, units jsonb,
            created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE audit_log (
            id serial PRIMARY KEY, actor_id text NOT NULL, actor_email text,
            action text NOT NULL, target_type text, target_id text,
            before jsonb, after jsonb, reason text, ip text,
            created_at timestamptz NOT NULL DEFAULT now()
        );
    `);
    const sql = neonLike(db);
    const [quota] = await sql`INSERT INTO quotas (project_id, user_id, model_id, type, "window", hard_limit)
        VALUES (31, NULL, NULL, 'usd', 'lifetime', 2000) RETURNING *`;
    return { sql, quota };
}

test('the overall cap can switch hard → soft without moving the cap', async () => {
    const { sql, quota } = await overallCapDb();
    const updated = await changeQuotaCapSafely(sql, {
        id: quota.id, newHardLimit: 2000, expectedHardLimit: 2000,
        newPolicy: 'soft', newSoftOveragePct: 10, before: quota, actor: admin,
    });
    assert.ok(updated, 'policy-only change should succeed');
    assert.equal(updated.policy, 'soft');
    assert.equal(Number(updated.soft_overage_pct), 10);
    assert.equal(Number(updated.hard_limit), 2000);
    const [audit] = await sql`SELECT * FROM audit_log WHERE action = 'quota.cap_changed'`;
    assert.equal(audit.before.policy, 'hard');
    assert.equal(audit.after.policy, 'soft');
});

test('raising the cap keeps the policy the caller passes through', async () => {
    const { sql, quota } = await overallCapDb();
    const updated = await changeQuotaCapSafely(sql, {
        id: quota.id, newHardLimit: 3000, expectedHardLimit: 2000,
        newPolicy: 'hard', newSoftOveragePct: 5, before: quota, actor: admin,
    });
    assert.equal(Number(updated.hard_limit), 3000);
    assert.equal(updated.policy, 'hard');
});

test('a policy change cannot smuggle the cap below spent plus in-flight', async () => {
    const { sql, quota } = await overallCapDb();
    // $1000 settled across the project — the cap floor for any edit.
    await sql`INSERT INTO billing_events (event_type, generation_id, project_id, user_id, model_id, cost_usd)
        VALUES ('settlement', 'g1', 31, 'u1', 'model-a', 1000)`;
    const updated = await changeQuotaCapSafely(sql, {
        id: quota.id, newHardLimit: 900, expectedHardLimit: 2000,
        newPolicy: 'soft', newSoftOveragePct: 10, before: quota, actor: admin,
    });
    assert.equal(updated, null, 'below the spend floor, nothing changes');
    const [row] = await sql`SELECT hard_limit, policy FROM quotas WHERE id = ${quota.id}`;
    assert.equal(Number(row.hard_limit), 2000);
    assert.equal(row.policy, 'hard', 'the policy must not change when the cap edit is rejected');
});

// --- policy resolution (the route's validation, made testable) ---------------

// Regression: 17 live budgets carry soft_overage_pct = 0 because a budget-request
// approval writes 0 for a hard policy. The console echoes that 0 back on every
// cap edit, so validating it unconditionally rejected the save with an error
// about a field the admin never touched — those budgets could not be edited at all.
test('a hard budget storing 0% overage can still have its cap edited', () => {
    const before = { policy: 'hard', soft_overage_pct: 0 };
    const edit = resolvePolicyEdit({ newPolicy: 'hard', newSoftOveragePct: 0 }, before);
    assert.equal(edit.error, undefined);
    assert.equal(edit.policy, 'hard');
    assert.equal(edit.softOveragePct, 0); // preserved, not invented
    assert.equal(edit.changed, false);    // a cap-only edit is not a policy change
});

test('the overage % is validated only when the budget becomes soft', () => {
    const before = { policy: 'hard', soft_overage_pct: 0 };
    assert.equal(resolvePolicyEdit({ newPolicy: 'soft', newSoftOveragePct: 0 }, before).error, 'overage');
    assert.equal(resolvePolicyEdit({ newPolicy: 'soft', newSoftOveragePct: 51 }, before).error, 'overage');
    assert.equal(resolvePolicyEdit({ newPolicy: 'soft', newSoftOveragePct: 7.5 }, before).error, 'overage');
    const ok = resolvePolicyEdit({ newPolicy: 'soft', newSoftOveragePct: 10 }, before);
    assert.equal(ok.softOveragePct, 10);
    assert.equal(ok.changed, true);
});

test('omitted fields keep the budget exactly as it is', () => {
    const before = { policy: 'soft', soft_overage_pct: 12 };
    const edit = resolvePolicyEdit({}, before);
    assert.deepEqual([edit.policy, edit.softOveragePct, edit.changed], ['soft', 12, false]);
});

test('an unknown policy is rejected', () => {
    assert.equal(resolvePolicyEdit({ newPolicy: 'elastic' }, { policy: 'hard', soft_overage_pct: 5 }).error, 'policy');
});
