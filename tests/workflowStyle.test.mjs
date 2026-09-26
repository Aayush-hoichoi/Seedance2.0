import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { workflowStyle, userWorkflowId, listWorkflowsFor } from '../lib/gateway/db.js';

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

const STYLE = { enabled: true, version: 1, defaultLook: 'a', looks: { a: { brief: 'painterly' } } };

async function workflowDb() {
    const db = new PGlite();
    await db.exec(`
        CREATE TABLE workflows (
            id serial PRIMARY KEY, name text NOT NULL, description text,
            style jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
            created_by text
        );
    `);
    await db.exec(`
        CREATE TABLE users (id text PRIMARY KEY, workflow_id integer);
        CREATE TABLE workflow_access (
            user_id text PRIMARY KEY, status text NOT NULL DEFAULT 'pending', note text,
            decided_by text, decided_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now()
        );
    `);
    const sql = neonLike(db);
    await sql`INSERT INTO workflows (name, style) VALUES ('Mahi Style', ${JSON.stringify(STYLE)}::jsonb)`;
    await sql`INSERT INTO workflows (name, style, deleted_at) VALUES ('Old Style', ${JSON.stringify(STYLE)}::jsonb, now())`;
    await sql`INSERT INTO workflows (name, style, created_by) VALUES ('My Noir', ${JSON.stringify(STYLE)}::jsonb, 'u_attached')`;
    await sql`INSERT INTO users (id, workflow_id) VALUES ('u_attached', 1), ('u_detached', NULL)`;
    await sql`INSERT INTO workflow_access (user_id, status) VALUES
        ('u_attached', 'approved'), ('u_pending', 'pending'), ('u_denied', 'denied')`;
    return sql;
}

const granted = { userId: 'u_attached', isAdmin: false };

test('workflowStyle returns the style only to a user with APPROVED workflow access', async () => {
    const sql = await workflowDb();
    assert.deepEqual(await workflowStyle(sql, 1, granted), STYLE);
    assert.equal(await workflowStyle(sql, 1, { userId: 'u_pending' }), null);
    assert.equal(await workflowStyle(sql, 1, { userId: 'u_denied' }), null);
    assert.equal(await workflowStyle(sql, 1, { userId: 'u_never_asked' }), null);
});

test('platform admins bypass the gate', async () => {
    const sql = await workflowDb();
    assert.deepEqual(await workflowStyle(sql, 1, { userId: 'u_never_asked', isAdmin: true }), STYLE);
});

test('workflowStyle is null for absent, unknown, deleted, or malformed ids — callers fall back to the project style', async () => {
    const sql = await workflowDb();
    assert.equal(await workflowStyle(sql, null, granted), null);
    assert.equal(await workflowStyle(sql, 999, granted), null);
    assert.equal(await workflowStyle(sql, 2, { userId: 'u_attached', isAdmin: true }), null); // soft-deleted
    assert.equal(await workflowStyle(sql, 'not-a-number', granted), null);
});

test('a custom workflow is usable only by its creator; officials by anyone granted', async () => {
    const sql = await workflowDb();
    await sql`INSERT INTO workflow_access (user_id, status) VALUES ('u_other', 'approved')`;
    assert.deepEqual(await workflowStyle(sql, 3, { userId: 'u_attached' }), STYLE); // creator, granted
    assert.equal(await workflowStyle(sql, 3, { userId: 'u_other' }), null);         // granted, but not theirs
    assert.deepEqual(await workflowStyle(sql, 1, { userId: 'u_other' }), STYLE);    // official: fine
});

test('listWorkflowsFor shows officials plus ONLY the caller\'s own customs, officials first', async () => {
    const sql = await workflowDb();
    await sql`INSERT INTO workflows (name, style, created_by) VALUES ('Their Secret', ${JSON.stringify(STYLE)}::jsonb, 'u_other')`;
    const mine = await listWorkflowsFor(sql, 'u_attached');
    assert.deepEqual(mine.map((w) => w.name), ['Mahi Style', 'My Noir']); // no deleted, no Their Secret
    const theirs = await listWorkflowsFor(sql, 'u_other');
    assert.deepEqual(theirs.map((w) => w.name), ['Mahi Style', 'Their Secret']);
});

test('userWorkflowId returns the stored attachment; null when detached or unknown', async () => {
    const sql = await workflowDb();
    assert.equal(await userWorkflowId(sql, 'u_attached'), 1);
    assert.equal(await userWorkflowId(sql, 'u_detached'), null);
    assert.equal(await userWorkflowId(sql, 'u_never_seen'), null);
    assert.equal(await userWorkflowId(sql, null), null);
});
