import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { changeQuotaScopeSafely, usageForQuotas } from '../lib/gateway/db.js';
import { applicableQuotas } from '../lib/gateway/quota.mjs';

const admin = { userId: 'user-admin', email: 'admin@example.com' };

function compile(strings, values) {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1]}`;
    return { text, values };
}

// Adapts PGlite to the small Neon tagged-query surface used by production
// (same shim as budgetRequestWorkflow.test.mjs).
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
    sql.query = async (text, values = []) => (await db.query(text, values)).rows;
    sql.transaction = (statements) => db.transaction(async (tx) => {
        const results = [];
        for (const statement of statements) results.push(await statement.execute(tx));
        return results;
    });
    return sql;
}

async function rescopeDb() {
    const db = new PGlite();
    await db.exec(`
        CREATE TABLE quotas (
            id serial PRIMARY KEY, project_id integer, user_id text, model_id text,
            type text NOT NULL, "window" text NOT NULL, hard_limit numeric NOT NULL,
            policy text NOT NULL DEFAULT 'hard', soft_overage_pct numeric NOT NULL DEFAULT 0,
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
    return neonLike(db);
}

async function seedQuota(sql, { modelId = 'model-a', projectId = 31 } = {}) {
    const [quota] = await sql`INSERT INTO quotas
        (project_id, user_id, model_id, type, "window", hard_limit)
        VALUES (${projectId}, NULL, ${modelId}, 'usd', 'lifetime', 100)
        RETURNING *`;
    return quota;
}

test('widening a model budget to all models re-attributes existing spend', async () => {
    const sql = await rescopeDb();
    const before = await seedQuota(sql);
    // $80 already settled on a DIFFERENT model in the same project.
    await sql`INSERT INTO billing_events (event_type, generation_id, project_id, user_id, model_id, cost_usd)
        VALUES ('settlement', 'g1', 31, 'u1', 'model-b', 80)`;

    const updated = await changeQuotaScopeSafely(sql, {
        id: before.id, newModelId: null, before, actor: admin,
        usage: { before: { used: 0, reserved: 0 }, after: { used: 80, reserved: 0 } },
    });
    assert.ok(updated, 'rescope should succeed');
    assert.equal(updated.model_id, null);

    // The widened quota now matches any model and counts model-b's spend.
    assert.equal(applicableQuotas([updated], { projectId: 31, userId: 'u1', modelId: 'model-b' }).length, 1);
    const { usedByQuota } = await usageForQuotas(sql, [updated]);
    assert.equal(Number(usedByQuota[updated.id]), 80);

    const [audit] = await sql`SELECT * FROM audit_log WHERE action = 'quota.rescope'`;
    assert.ok(audit, 'audit row written');
    assert.equal(audit.after.usage_at_rescope.after.used, 80);
});

test('a stale expected scope changes nothing', async () => {
    const sql = await rescopeDb();
    const before = await seedQuota(sql);
    // Another admin rescoped in between: the caller still holds the old row.
    const staleBefore = { ...before, model_id: 'model-z' };
    const updated = await changeQuotaScopeSafely(sql, {
        id: before.id, newModelId: null, before: staleBefore, actor: admin, usage: null,
    });
    assert.equal(updated, null);
    const [row] = await sql`SELECT model_id FROM quotas WHERE id = ${before.id}`;
    assert.equal(row.model_id, 'model-a');
    const audits = await sql`SELECT id FROM audit_log`;
    assert.equal(audits.length, 0, 'no audit row for a no-op');
});

test('rescoping onto an occupied scope is rejected, not merged', async () => {
    const sql = await rescopeDb();
    const before = await seedQuota(sql);
    // An all-models budget for the same project/type/window already exists.
    await sql`INSERT INTO quotas (project_id, user_id, model_id, type, "window", hard_limit)
        VALUES (31, NULL, NULL, 'usd', 'lifetime', 500)`;

    const updated = await changeQuotaScopeSafely(sql, {
        id: before.id, newModelId: null, before, actor: admin, usage: null,
    });
    assert.equal(updated, null);
    const [row] = await sql`SELECT model_id FROM quotas WHERE id = ${before.id}`;
    assert.equal(row.model_id, 'model-a', 'original scope untouched');
});
