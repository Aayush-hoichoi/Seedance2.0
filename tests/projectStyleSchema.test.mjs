// End-to-end over a real Postgres (PGlite): the v18 DDL applies on top of the
// full chain, projects.style round-trips, and dataset_samples can answer the
// one question the style feature exists to answer — "is the style raising the
// like rate, per project, per look, per version?"
//
// The unit tests prove the composer; this proves the substrate it reports into.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { GATEWAY_DDL } from '../lib/db/schema.mjs';

function compile(strings, values) {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1]}`;
    return { text, values };
}

function neonLike(db) {
    function sql(strings, ...values) {
        const query = compile(strings, values);
        const token = {
            async execute(client = db) { return (await client.query(query.text, query.values)).rows; },
            then(onFulfilled, onRejected) { return token.execute().then(onFulfilled, onRejected); },
        };
        return token;
    }
    return sql;
}

// getDb() creates these before GATEWAY_DDL runs (lib/db/neon.js); only the
// columns the views below read are reproduced.
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
    return { db, sql };
}

let seq = 0;
async function insertVideoJob(sql, { look = null, version = null, liked = false, prompt = 'a shot' } = {}) {
    seq += 1;
    const taskId = `cgt-${seq}`;
    const body = JSON.stringify({
        category: 'video',
        prompt,
        options: {
            resolution: '720p', duration: 7, ratio: '16:9', mode: 'reference',
            style_look: look, style_version: version,
        },
    });
    await sql`INSERT INTO jobs (project_id, user_id, model_id, priority, status, request_body,
            provider_task_id, result, started_at)
        VALUES (33, 'u1', 'seedance-2.0', 'interactive', 'succeeded', ${body}::jsonb,
            ${taskId}, ${JSON.stringify({ video_key: `videos/${taskId}.mp4` })}::jsonb, now())`;
    if (liked) {
        await sql`INSERT INTO generation_events (task_id, user_id, project_id, event_type)
            VALUES (${taskId}, 'u1', 33, 'like')`;
    }
    return taskId;
}

test('the v18 chain applies and projects.style round-trips as jsonb', async () => {
    const { sql } = await freshDb();
    const style = {
        enabled: true, version: 3, defaultLook: 'global',
        looks: { global: { name: 'Painterly', brief: 'Stylized painterly 3D game-simulation render.' } },
        characters: { Menaka: 'copper-rose veil' },
    };
    await sql`UPDATE projects SET style = ${JSON.stringify(style)}::jsonb WHERE id = 33`;
    const [row] = await sql`SELECT style FROM projects WHERE id = 33`;
    assert.equal(row.style.version, 3);
    assert.equal(row.style.looks.global.brief, 'Stylized painterly 3D game-simulation render.');

    // NULL is the opt-out, and it must be the default for every other project.
    await sql`INSERT INTO projects (id, name) VALUES (99, 'Untouched')`;
    const [other] = await sql`SELECT style FROM projects WHERE id = 99`;
    assert.equal(other.style, null);
});

test('a video job now persists the prompt the provider received', async () => {
    // Before v18 the video path stored no prompt at all: the only server-side
    // record was whatever the browser later posted to seedance_prompts, so a
    // server-composed prompt was unauditable and MCP callers wrote nothing.
    const { sql } = await freshDb();
    const taskId = await insertVideoJob(sql, { look: 'global', version: 3, prompt: 'a shot\n\n[PROJECT STYLE — LOCKED]\npainterly' });
    const [row] = await sql`SELECT sent_prompt, style_look, style_version, project_id
        FROM dataset_samples WHERE task_id = ${taskId}`;
    assert.match(row.sent_prompt, /PROJECT STYLE — LOCKED/);
    assert.equal(row.style_look, 'global');
    assert.equal(row.style_version, 3);
    assert.equal(row.project_id, 33);
});

test('dataset_samples can score like-rate per project, look and style version', async () => {
    const { sql } = await freshDb();
    // Baseline: unstyled, 1 like in 4. Styled v3: 3 likes in 4.
    await insertVideoJob(sql, { liked: true });
    for (let i = 0; i < 3; i += 1) await insertVideoJob(sql, {});
    await insertVideoJob(sql, { look: 'global', version: 3, liked: true });
    await insertVideoJob(sql, { look: 'global', version: 3, liked: true });
    await insertVideoJob(sql, { look: 'global', version: 3, liked: true });
    await insertVideoJob(sql, { look: 'global', version: 3 });

    const rows = await sql`SELECT style_look, style_version, count(*)::int AS n,
            count(*) FILTER (WHERE likes > 0)::int AS liked
        FROM dataset_samples WHERE project_id = 33
        GROUP BY 1, 2 ORDER BY style_version NULLS FIRST`;
    assert.equal(rows.length, 2);
    assert.deepEqual(
        { look: rows[0].style_look, n: rows[0].n, liked: rows[0].liked },
        { look: null, n: 4, liked: 1 },
        'unstyled baseline',
    );
    assert.deepEqual(
        { look: rows[1].style_look, version: rows[1].style_version, n: rows[1].n, liked: rows[1].liked },
        { look: 'global', version: 3, n: 4, liked: 3 },
        'styled cohort, attributable to look and version',
    );
});

test('the browser-recorded prompt and the sent prompt stay distinguishable', async () => {
    // dataset_samples.prompt keeps its old meaning (what the user typed, as the
    // browser recorded it). sent_prompt is what the provider got. They differ
    // exactly when a style fired — which is what makes the layer measurable.
    const { sql } = await freshDb();
    const taskId = await insertVideoJob(sql, { look: 'global', version: 3, prompt: 'Menaka bows.\n\nSTYLE BLOCK' });
    await sql`INSERT INTO seedance_prompts (task_id, user_prompt, project_id) VALUES (${taskId}, 'Menaka bows.', 33)`;
    const [row] = await sql`SELECT prompt, user_prompt, sent_prompt FROM dataset_samples WHERE task_id = ${taskId}`;
    assert.equal(row.prompt, 'Menaka bows.');
    assert.equal(row.user_prompt, 'Menaka bows.');
    assert.match(row.sent_prompt, /STYLE BLOCK/);
    assert.notEqual(row.prompt, row.sent_prompt);
});

test('an image job reports its style the same way a video job does', async () => {
    // The two pipelines build request_body independently, so the stamp is easy
    // to spell two ways — and gallery_generations reads exactly one of them.
    const { sql } = await freshDb();
    const body = JSON.stringify({
        category: 'image',
        prompt: 'Menaka bows.\n\n[PROJECT STYLE — LOCKED]\npainterly',
        options: { imageCount: 1, imageSize: '2K', style_look: 'painterly', style_version: 1 },
    });
    await sql`INSERT INTO jobs (project_id, user_id, model_id, priority, status, request_body, result, started_at)
        VALUES (33, 'u1', 'nano-banana-pro', 'interactive', 'succeeded', ${body}::jsonb,
            ${JSON.stringify({ images: [{ key: 'images/job-1-0.png' }] })}::jsonb, now())`;
    const [row] = await sql`SELECT category, style_look, style_version, sent_prompt, project_id
        FROM dataset_samples WHERE category = 'image'`;
    assert.equal(row.style_look, 'painterly');
    assert.equal(row.style_version, 1);
    assert.equal(row.project_id, 33);
    assert.match(row.sent_prompt, /PROJECT STYLE — LOCKED/);
});
