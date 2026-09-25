import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { overCommitsProject, projectAllocation } from '../lib/gateway/db.js';

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
    return sql;
}

const PROJECT = 31;

async function quotaDb(rows = []) {
    const db = new PGlite();
    await db.exec(`
        CREATE TABLE quotas (
            id serial PRIMARY KEY, project_id integer, user_id text, model_id text,
            type text NOT NULL, "window" text NOT NULL, hard_limit numeric NOT NULL,
            deleted_at timestamptz
        );
    `);
    const sql = neonLike(db);
    for (const row of rows) {
        await sql`INSERT INTO quotas (project_id, user_id, model_id, type, "window", hard_limit, deleted_at)
            VALUES (${row.projectId ?? PROJECT}, ${row.userId ?? null}, ${row.modelId ?? null},
                    ${row.type ?? 'usd'}, ${row.window ?? 'lifetime'}, ${row.hardLimit}, ${row.deletedAt ?? null})`;
    }
    return sql;
}

const member = (extra) => ({ projectId: PROJECT, userId: 'u_neha', type: 'usd', window: 'lifetime', ...extra });

test('allocation: the overall budget is the cap, member dollar budgets are what is allotted', async () => {
    const sql = await quotaDb([
        { hardLimit: 1000 },                                                  // overall
        { userId: 'u_neha', modelId: 'a', hardLimit: 300 },
        { userId: 'u_raktim', modelId: 'b', hardLimit: 150 },
        { modelId: 'b', hardLimit: 400 },                                     // everyone sub-cap, not an allocation
        { userId: 'u_raktim', type: 'video_seconds', hardLimit: 600 },        // other unit
        { userId: 'u_gone', modelId: 'a', hardLimit: 999, deletedAt: 'now()' },
        { projectId: 99, userId: 'u_neha', modelId: 'a', hardLimit: 5000 },   // another project
    ]);
    assert.deepEqual(await projectAllocation(sql, PROJECT), { overallCap: 1000, allocated: 450 });
});

test('a member budget may grow into the unallotted headroom, but no further', async () => {
    const sql = await quotaDb([{ hardLimit: 1000 }, { userId: 'u_raktim', modelId: 'b', hardLimit: 900 }]);
    assert.equal(await overCommitsProject(sql, member({ nextLimit: 100 })), null); // exactly fills the cap
    assert.deepEqual(await overCommitsProject(sql, member({ nextLimit: 100.01 })), {
        overallCap: 1000, allocated: 900, requested: 100.01, available: 100,
    });
});

test('editing a member budget compares against the OTHER members only', async () => {
    const sql = await quotaDb([
        { hardLimit: 1000 },
        { userId: 'u_neha', modelId: 'a', hardLimit: 400 },
        { userId: 'u_raktim', modelId: 'b', hardLimit: 500 },
    ]);
    const [neha] = await sql`SELECT id FROM quotas WHERE user_id = 'u_neha'`;
    // Raising 400 → 500 leaves 500 for the others: allowed. 501 would not be.
    assert.equal(await overCommitsProject(sql, member({ quotaId: neha.id, nextLimit: 500 })), null);
    assert.equal((await overCommitsProject(sql, member({ quotaId: neha.id, nextLimit: 501 }))).available, 500);
    // Without the exclusion the same 500 reads as a delta on top of all 900.
    assert.equal((await overCommitsProject(sql, member({ nextLimit: 500 }))).available, 100);
});

test('no overall budget means members are uncapped', async () => {
    const sql = await quotaDb([{ userId: 'u_raktim', modelId: 'b', hardLimit: 900 }]);
    assert.equal((await projectAllocation(sql, PROJECT)).overallCap, null);
    assert.equal(await overCommitsProject(sql, member({ nextLimit: 1e9 })), null);
});

test('only project-scoped member dollar lifetime budgets are sub-allocations', async () => {
    const sql = await quotaDb([{ hardLimit: 10 }]);
    const huge = { nextLimit: 1e6 };
    assert.equal(await overCommitsProject(sql, member({ ...huge, type: 'image_count' })), null);
    assert.equal(await overCommitsProject(sql, member({ ...huge, window: 'monthly' })), null);
    assert.equal(await overCommitsProject(sql, member({ ...huge, userId: null })), null); // the overall itself
    assert.equal(await overCommitsProject(sql, member({ ...huge, projectId: null })), null); // workspace-wide
    assert.notEqual(await overCommitsProject(sql, member(huge)), null);
});
