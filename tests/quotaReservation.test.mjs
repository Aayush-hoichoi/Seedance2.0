import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { reserveBillingEvent } from '../lib/gateway/db.js';

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

async function reservationDb() {
    const db = new PGlite();
    await db.exec(`
        CREATE TABLE quotas (
            id serial PRIMARY KEY, project_id integer, user_id text, model_id text,
            type text NOT NULL, "window" text NOT NULL, hard_limit numeric NOT NULL,
            policy text NOT NULL DEFAULT 'hard', soft_overage_pct numeric NOT NULL DEFAULT 5,
            created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
        );
        CREATE TABLE billing_events (
            id serial PRIMARY KEY, event_type text NOT NULL, generation_id text,
            project_id integer, user_id text, model_id text, model_version_id text,
            provider_id text, api_key_id text, units jsonb,
            est_cost_usd numeric, cost_usd numeric, pricing_snapshot jsonb,
            created_at timestamptz NOT NULL DEFAULT now()
        );
    `);
    return neonLike(db);
}

async function addQuota(sql, { projectId = 31, userId = null, modelId = null, limit }) {
    await sql`INSERT INTO quotas (project_id, user_id, model_id, type, "window", hard_limit)
        VALUES (${projectId}, ${userId}, ${modelId}, 'usd', 'lifetime', ${limit})`;
}

async function settle(sql, { projectId = 31, userId, modelId = 'seedance', usd }) {
    await sql`INSERT INTO billing_events (event_type, generation_id, project_id, user_id, model_id, cost_usd)
        VALUES ('settlement', ${`g-${Math.random()}`}, ${projectId}, ${userId}, ${modelId}, ${usd})`;
}

const reserve = (sql, usd = 5) => reserveBillingEvent(sql, {
    eventType: 'reservation', generationId: 'g-new', projectId: 31, userId: 'neha',
    modelId: 'seedance', units: { video_seconds: 10 }, estCostUsd: usd, pricingSnapshot: null,
});

test('an exhausted personal budget rides the shared pool while it has room', async () => {
    const sql = await reservationDb();
    await addQuota(sql, { userId: null, limit: 800 });          // shared pool, $47 headroom worth
    await addQuota(sql, { userId: 'neha', modelId: 'seedance', limit: 50 });
    await settle(sql, { userId: 'neha', usd: 49 });             // personal cap effectively exhausted

    const row = await reserve(sql, 5);
    assert.ok(row, 'reservation should be forgiven by the shared pool');
});

test('an exhausted shared pool is topped up by a personal budget with headroom', async () => {
    const sql = await reservationDb();
    await addQuota(sql, { userId: null, limit: 100 });
    await addQuota(sql, { userId: 'neha', limit: 500 });
    await settle(sql, { userId: 'other', usd: 99 });            // shared pool drained by the team

    const row = await reserve(sql, 5);
    assert.ok(row, 'personal budget should top up the drained shared pool');
});

test('blocks when both sides of the wallet group are exhausted', async () => {
    const sql = await reservationDb();
    await addQuota(sql, { userId: null, limit: 100 });
    await addQuota(sql, { userId: 'neha', limit: 50 });
    await settle(sql, { userId: 'other', usd: 99 });
    await settle(sql, { userId: 'neha', usd: 49 });

    const row = await reserve(sql, 5);
    assert.equal(row, null, 'no wallet in the group has room');
});

test('a member with only a personal budget is still bound by it', async () => {
    const sql = await reservationDb();
    await addQuota(sql, { userId: 'neha', limit: 50 });
    await settle(sql, { userId: 'neha', usd: 49 });

    const row = await reserve(sql, 5);
    assert.equal(row, null, 'no shared pool exists to forgive the overage');
});

test('workspace-wide quotas never group and always bind', async () => {
    const sql = await reservationDb();
    await addQuota(sql, { projectId: null, userId: null, limit: 100 }); // workspace-wide
    await addQuota(sql, { userId: 'neha', limit: 500 });
    await settle(sql, { userId: 'other', usd: 99 });

    const row = await reserve(sql, 5);
    assert.equal(row, null, 'workspace cap binds despite personal headroom');
});
