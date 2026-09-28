import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { workflowStyle, userWorkflowIds, listWorkflowsFor } from '../lib/gateway/db.js';

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
            created_by text, visibility text NOT NULL DEFAULT 'private',
            media text NOT NULL DEFAULT 'all'
        );
    `);
    await db.exec(`
        CREATE TABLE users (id text PRIMARY KEY, email text, workflow_id integer, image_workflow_id integer);
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

test('a PUBLIC custom is listed and usable by everyone with access; pending is not', async () => {
    const sql = await workflowDb();
    await sql`INSERT INTO workflow_access (user_id, status) VALUES ('u_other', 'approved')`;
    await sql`INSERT INTO workflows (name, style, created_by, visibility)
        VALUES ('Shared Noir', ${JSON.stringify(STYLE)}::jsonb, 'u_attached', 'public'),
               ('Half Shared', ${JSON.stringify(STYLE)}::jsonb, 'u_attached', 'pending')`;
    const others = await listWorkflowsFor(sql, 'u_other');
    assert.ok(others.some((w) => w.name === 'Shared Noir'));       // published: visible
    assert.ok(!others.some((w) => w.name === 'Half Shared'));      // owner asked, admin has not agreed
    const [shared] = await sql`SELECT id FROM workflows WHERE name = 'Shared Noir'`;
    assert.deepEqual(await workflowStyle(sql, shared.id, { userId: 'u_other' }), STYLE);
    const [half] = await sql`SELECT id FROM workflows WHERE name = 'Half Shared'`;
    assert.equal(await workflowStyle(sql, half.id, { userId: 'u_other' }), null);
});

test('an "all" attachment governs BOTH media; the image slot overrides for images', async () => {
    const sql = await workflowDb();
    // Main slot holds workflow 1 (media 'all') → both channels.
    assert.deepEqual(await userWorkflowIds(sql, 'u_attached'), { video: 1, image: 1 });
    assert.deepEqual(await userWorkflowIds(sql, 'u_detached'), { video: null, image: null });
    assert.deepEqual(await userWorkflowIds(sql, 'u_never_seen'), { video: null, image: null });
    assert.deepEqual(await userWorkflowIds(sql, null), { video: null, image: null });

    // An image-only workflow in the image slot wins for images; video keeps the main.
    await sql`INSERT INTO workflows (name, style, created_by, media) VALUES ('Img Only', ${JSON.stringify(STYLE)}::jsonb, 'u_attached', 'image')`;
    const [img] = await sql`SELECT id FROM workflows WHERE name = 'Img Only'`;
    await sql`UPDATE users SET image_workflow_id = ${img.id} WHERE id = 'u_attached'`;
    assert.deepEqual(await userWorkflowIds(sql, 'u_attached'), { video: 1, image: img.id });

    // A video-only main covers video but NOT image.
    await sql`INSERT INTO workflows (name, style, created_by, media) VALUES ('Vid Only', ${JSON.stringify(STYLE)}::jsonb, 'u_attached', 'video')`;
    const [vid] = await sql`SELECT id FROM workflows WHERE name = 'Vid Only'`;
    await sql`UPDATE users SET workflow_id = ${vid.id}, image_workflow_id = NULL WHERE id = 'u_attached'`;
    assert.deepEqual(await userWorkflowIds(sql, 'u_attached'), { video: vid.id, image: null });
});

test('workflowStyle refuses a workflow for the wrong medium', async () => {
    const sql = await workflowDb();
    await sql`INSERT INTO workflows (name, style, created_by, media) VALUES ('Img Only', ${JSON.stringify(STYLE)}::jsonb, 'u_attached', 'image')`;
    const [img] = await sql`SELECT id FROM workflows WHERE name = 'Img Only'`;
    assert.deepEqual(await workflowStyle(sql, img.id, { userId: 'u_attached', media: 'image' }), STYLE);
    assert.equal(await workflowStyle(sql, img.id, { userId: 'u_attached', media: 'video' }), null);
    // 'all' workflows serve both media.
    assert.deepEqual(await workflowStyle(sql, 1, { userId: 'u_attached', media: 'video' }), STYLE);
    assert.deepEqual(await workflowStyle(sql, 1, { userId: 'u_attached', media: 'image' }), STYLE);
});
