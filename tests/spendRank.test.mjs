import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { getMonthSpendRank } from '../lib/access/db.js';
import { normalizeSpendRank } from '../lib/seedance/spendRank.mjs';

function compile(strings, values) {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1]}`;
    return { text, values };
}

function neonLike(db) {
    return async (strings, ...values) => {
        const query = compile(strings, values);
        return (await db.query(query.text, query.values)).rows;
    };
}

async function rankDb() {
    const db = new PGlite();
    await db.exec(`CREATE TABLE billing_events (
        event_type text NOT NULL,
        project_id integer NOT NULL,
        user_id text NOT NULL,
        cost_usd numeric,
        est_cost_usd numeric,
        created_at timestamptz NOT NULL DEFAULT now()
    )`);
    return { db, sql: neonLike(db) };
}

test('month spend rank compares a user across every project and preserves ties', async () => {
    const { db, sql } = await rankDb();
    await db.exec(`
        INSERT INTO billing_events (event_type, project_id, user_id, cost_usd) VALUES
            ('settlement', 1, 'leader', 10),
            ('settlement', 1, 'current', 2),
            ('failure',    2, 'current', NULL),
            ('settlement', 2, 'current', 3),
            ('settlement', 3, 'tied', 5),
            ('settlement', 3, 'fourth', 1);
        UPDATE billing_events SET est_cost_usd = 0 WHERE est_cost_usd IS NULL;
        INSERT INTO billing_events (event_type, project_id, user_id, cost_usd, created_at)
            VALUES ('settlement', 9, 'current', 1000, '2000-01-01T00:00:00Z');
        INSERT INTO billing_events (event_type, project_id, user_id, cost_usd)
            VALUES ('reservation', 9, 'current', 1000);
    `);

    assert.deepEqual(await getMonthSpendRank('current', sql), { rank: 2, userCount: 4 });
    assert.deepEqual(await getMonthSpendRank('tied', sql), { rank: 2, userCount: 4 });
    assert.equal(await getMonthSpendRank('no-usage', sql), null);
});

test('rank presentation accepts valid API data and rejects malformed positions', () => {
    assert.deepEqual(normalizeSpendRank({ rank: '3', userCount: '8' }), {
        rank: 3, userCount: 8, label: '#3', detail: '#3 of 8',
    });
    assert.deepEqual(normalizeSpendRank({ rank: 2, userCount: null }), {
        rank: 2, userCount: null, label: '#2', detail: '#2',
    });
    for (const bad of [null, {}, { rank: 0 }, { rank: 1.5 }, { rank: 'nope' }]) {
        assert.equal(normalizeSpendRank(bad), null);
    }
});
