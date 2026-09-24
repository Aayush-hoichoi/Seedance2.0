// End-to-end over a real Postgres (PGlite): the v20 view changes that make a
// user's history complete. Two holes existed:
//   • a multi-image job (imageCount up to 4) surfaced only result->images->0,
//     so three of four generated images were invisible everywhere;
//   • createVideoTask's fail-open path (resolveGateway error) wrote only a
//     usage_events row — no jobs row — so the generation never appeared in
//     history at all.
// Both are read back through the REAL gallery_generations view + the real
// queryUserGenerations SQL, not a hand-built fixture table.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { GATEWAY_DDL } from '../lib/db/schema.mjs';
import { queryUserGenerations } from '../lib/access/galleryQueries.mjs';

function compile(strings, values) {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1]}`;
    return { text, values };
}

function neonLike(db) {
    return function sql(strings, ...values) {
        const query = compile(strings, values);
        return db.query(query.text, query.values).then((result) => result.rows);
    };
}

// getDb() creates these before GATEWAY_DDL runs (lib/db/neon.js); only the
// columns the view + gallery query read are reproduced.
const PRE_GATEWAY_DDL = [
    `CREATE TABLE seedance_prompts (
        task_id text PRIMARY KEY,
        style text, user_prompt text, generated_prompt text,
        refs jsonb,
        liked boolean NOT NULL DEFAULT false,
        deleted boolean NOT NULL DEFAULT false,
        project_id integer,
        created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE users (
        id text PRIMARY KEY, email text, name text, role text,
        created_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
    )`,
    `CREATE TABLE usage_events (
        id serial PRIMARY KEY, user_id text NOT NULL, user_email text NOT NULL,
        model_id text NOT NULL, resolution text, duration integer, ratio text, mode text,
        has_video_input boolean NOT NULL DEFAULT false, task_id text,
        status text NOT NULL DEFAULT 'created', completion_tokens bigint,
        est_cost_usd numeric(10,4), cost_usd numeric(10,4),
        created_at timestamptz NOT NULL DEFAULT now(), finalized_at timestamptz,
        UNIQUE (task_id)
    )`,
    `CREATE TABLE model_access_requests (
        id serial PRIMARY KEY, user_id text NOT NULL, user_email text NOT NULL,
        model_id text NOT NULL, status text NOT NULL, note text, decided_by text,
        created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz,
        expires_at timestamptz, project_id integer,
        max_resolution text, pending_max_resolution text
    )`,
];

async function freshDb() {
    const db = new PGlite();
    for (const ddl of PRE_GATEWAY_DDL) await db.query(ddl);
    for (const ddl of GATEWAY_DDL) await db.query(ddl);
    const sql = neonLike(db);
    await sql`INSERT INTO projects (id, name) VALUES (33, 'MAHISHASUR MARDINI')`;
    await sql`INSERT INTO users (id, email, name) VALUES ('u1', 'a@hoichoi.tv', 'A')`;
    return { sql };
}

test('a multi-image job exposes every stored image, not just the first', async () => {
    const { sql } = await freshDb();
    const body = JSON.stringify({ category: 'image', prompt: 'four variations', options: { imageSize: '2K' } });
    const result = JSON.stringify({
        images: [0, 1, 2, 3].map((i) => ({ key: `images/job-1-${i}.png` })),
    });
    await sql`INSERT INTO jobs (project_id, user_id, model_id, priority, status, request_body, result, started_at)
        VALUES (33, 'u1', 'nano-banana', 'batch', 'succeeded', ${body}::jsonb, ${result}::jsonb, now())`;

    const rows = await queryUserGenerations(sql, { userId: 'u1' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].image_key, 'images/job-1-0.png');
    assert.deepEqual(rows[0].images.map((im) => im.key),
        ['images/job-1-0.png', 'images/job-1-1.png', 'images/job-1-2.png', 'images/job-1-3.png']);
});

test('a fail-open generation (usage_events only, no jobs row) still reaches history', async () => {
    const { sql } = await freshDb();
    // The gateway path: normal job with a provider task id.
    const body = JSON.stringify({ category: 'video', prompt: 'a shot', options: { resolution: '720p' } });
    await sql`INSERT INTO jobs (project_id, user_id, model_id, priority, status, request_body, provider_task_id, started_at)
        VALUES (33, 'u1', 'seedance-2.0', 'interactive', 'succeeded', ${body}::jsonb, 'cgt-jobs', now())`;
    // Same task also logged to usage_events (both paths log usage) — must NOT duplicate.
    await sql`INSERT INTO usage_events (user_id, user_email, model_id, task_id, status)
        VALUES ('u1', 'a@hoichoi.tv', 'seedance-2.0', 'cgt-jobs', 'succeeded')`;
    // The fail-open path: usage row with no jobs row, never finalized.
    await sql`INSERT INTO usage_events (user_id, user_email, model_id, resolution, duration, task_id, status)
        VALUES ('u1', 'a@hoichoi.tv', 'seedance-2.0', '1080p', 7, 'cgt-orphan', 'created')`;

    const rows = await queryUserGenerations(sql, { userId: 'u1' });
    const ids = rows.map((r) => r.task_id).sort();
    assert.deepEqual(ids, ['cgt-jobs', 'cgt-orphan']);
    const orphan = rows.find((r) => r.task_id === 'cgt-orphan');
    assert.equal(orphan.status, 'running', "'created' maps to 'running' so it renders as in-flight, not error");
    assert.equal(orphan.category, 'video');
});
