// End-to-end over a real Postgres (PGlite): the v14 DDL, the generation_ledger
// view, and the tick that fills ledger_rows / ledger_sync.
//
// This is where the SQL is actually exercised. The unit tests prove the session
// logic; this proves the view can produce the rows that logic runs on — every
// status, both media, both eras — and that running the tick twice does not
// produce a second copy of anything.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { GATEWAY_DDL } from '../lib/db/schema.mjs';
import { runLedgerTick, readWatermark } from '../lib/ledger/sync.mjs';

function compile(strings, values) {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1]}`;
    return { text, values };
}

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
    return sql;
}

// getDb() creates these four before it runs GATEWAY_DDL (lib/db/neon.js), and
// the gateway DDL alters some of them, so the harness has to stand them up in
// the same order. Only the columns generation_ledger reads are reproduced.
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
    await sql`INSERT INTO projects (id, name) VALUES (1, 'Hooliganism')`;
    await sql`INSERT INTO users (id, email, name) VALUES ('u1', 'shinjini.nandy@hoichoi.tv', 'Shinjini Nandy')`;
    return { db, sql };
}

// jobs.updated_at is system-owned: the trigger overwrites any value an UPDATE
// supplies, which is exactly what it is for. Setting a fixture timestamp
// therefore means suspending it for the one statement.
async function forceUpdatedAt(db, sql, timestamp) {
    await db.query('ALTER TABLE jobs DISABLE TRIGGER jobs_set_updated_at');
    await sql`UPDATE jobs SET updated_at = ${timestamp}::timestamptz`;
    await db.query('ALTER TABLE jobs ENABLE TRIGGER jobs_set_updated_at');
}

let seq = 0;
async function insertJob(sql, { status = 'queued', category = 'video', minutes = 0, ...over } = {}) {
    seq += 1;
    const body = JSON.stringify({
        category, prompt: 'a wide cinematic shot of a train crossing a bridge at dusk',
        options: { resolution: '1080p', duration: 10, ratio: '16:9' },
    });
    const [row] = await sql`INSERT INTO jobs
            (project_id, user_id, model_id, status, request_body, created_at, updated_at,
             provider_task_id, result, error, finished_at)
        VALUES (1, 'u1', 'seedance-2.0', ${status}, ${body}::jsonb,
                now() + make_interval(mins => ${minutes}), now(),
                ${over.providerTaskId ?? null},
                ${over.result ? JSON.stringify(over.result) : null}::jsonb,
                ${over.error ? JSON.stringify(over.error) : null}::jsonb,
                ${over.finished ? 'now()' : null}::timestamptz)
        RETURNING id`;
    return row.id;
}

test('the v14 DDL applies cleanly to an empty database', async () => {
    const { db } = await freshDb();
    const [{ count }] = (await db.query(
        `SELECT count(*)::int AS count FROM information_schema.tables
         WHERE table_name IN ('ledger_rows', 'ledger_sync')`,
    )).rows;
    assert.equal(count, 2);
    const [{ has }] = (await db.query(
        `SELECT count(*)::int AS has FROM information_schema.columns
         WHERE table_name = 'jobs' AND column_name = 'updated_at'`,
    )).rows;
    assert.equal(has, 1);
});

test('the updated_at trigger fires on every UPDATE, including markSubmitted', async () => {
    const { sql } = await freshDb();
    const id = await insertJob(sql);
    const [before] = await sql`SELECT updated_at FROM jobs WHERE id = ${id}`;

    // markSubmitted writes provider_task_id with NO status change and emits no
    // event — the exact write a status-triggered sync would miss.
    await sql`UPDATE jobs SET provider_task_id = 'cgt-abc' WHERE id = ${id}`;
    const [after] = await sql`SELECT updated_at FROM jobs WHERE id = ${id}`;
    assert.ok(new Date(after.updated_at) > new Date(before.updated_at));
});

test('generation_ledger includes EVERY status, not just succeeded', async () => {
    const { sql } = await freshDb();
    for (const status of ['queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'rejected']) {
        await insertJob(sql, { status });
    }
    const rows = await sql`SELECT status FROM generation_ledger ORDER BY status`;
    assert.equal(rows.length, 7);
    assert.deepEqual(
        rows.map((r) => r.status).sort(),
        ['cancelled', 'failed', 'queued', 'rejected', 'running', 'succeeded', 'timed_out'],
    );
});

test('a failure with no provider task id still gets a row — gallery_generations drops these', async () => {
    const { sql } = await freshDb();
    const id = await insertJob(sql, {
        status: 'failed', finished: true,
        error: { message: "Image was blocked by the model's safety filter" },
    });
    const [row] = await sql`SELECT * FROM generation_ledger WHERE row_key = ${`job:${id}`}`;
    assert.ok(row, 'the row must exist even with provider_task_id NULL');
    assert.equal(row.task_id, null);
    assert.equal(row.error_message, "Image was blocked by the model's safety filter");
    assert.equal(row.output_key, null);

    // The view this replaces would have discarded it.
    const dropped = await sql`SELECT count(*)::int AS n FROM gallery_generations WHERE user_id = 'u1'`;
    assert.equal(dropped[0].n, 0, 'gallery_generations filters provider_task_id IS NOT NULL');
});

test('pre-gateway prompts appear as their own era and are not double-counted', async () => {
    const { sql } = await freshDb();
    await sql`INSERT INTO seedance_prompts (task_id, user_prompt, created_at)
        VALUES ('cgt-old-1', 'the people in image 1 are acting like video 1', now())`;
    // A prompt that DOES belong to a job must not also appear as pre-gateway.
    const id = await insertJob(sql, { status: 'succeeded', providerTaskId: 'cgt-new-1' });
    await sql`INSERT INTO seedance_prompts (task_id, user_prompt) VALUES ('cgt-new-1', 'linked')`;

    const rows = await sql`SELECT row_key, era FROM generation_ledger ORDER BY row_key`;
    assert.deepEqual(rows.map((r) => r.row_key).sort(), [`job:${id}`, 'pre:cgt-old-1']);
    assert.equal(rows.find((r) => r.row_key === 'pre:cgt-old-1').era, 'Pre-gateway');
});

test('images and videos share one ledger, discriminated by media', async () => {
    const { sql } = await freshDb();
    await insertJob(sql, { category: 'image', status: 'succeeded' });
    await insertJob(sql, { category: 'video', status: 'succeeded' });
    const rows = await sql`SELECT media FROM generation_ledger ORDER BY media`;
    assert.deepEqual(rows.map((r) => r.media), ['Image', 'Video']);
});

test('a tick stages rows and queues them for both workbooks', async () => {
    const { sql } = await freshDb();
    await insertJob(sql, { status: 'queued', category: 'video' });
    await insertJob(sql, { status: 'queued', category: 'image' });

    const result = await runLedgerTick(sql);
    assert.equal(result.written, 2);

    const staged = await sql`SELECT row_key, media, status FROM ledger_rows ORDER BY media`;
    assert.equal(staged.length, 2);

    // master takes everything; video takes only Video.
    const master = await sql`SELECT count(*)::int AS n FROM ledger_sync WHERE target_id = 'master'`;
    const video = await sql`SELECT count(*)::int AS n FROM ledger_sync WHERE target_id = 'video'`;
    assert.equal(master[0].n, 2);
    assert.equal(video[0].n, 1, 'the image must not be queued for the video workbook');
});

test('running the tick twice adds nothing — the idempotency the sheet depends on', async () => {
    const { sql } = await freshDb();
    await insertJob(sql, { status: 'queued' });
    await runLedgerTick(sql);
    const first = await sql`SELECT count(*)::int AS n FROM ledger_rows`;

    const again = await runLedgerTick(sql);
    const second = await sql`SELECT count(*)::int AS n FROM ledger_rows`;
    assert.equal(again.changed, 0, 'the watermark must have consumed the change');
    assert.equal(second[0].n, first[0].n);
});

test('a generation UPDATES its row through the lifecycle, never appends a second', async () => {
    const { sql } = await freshDb();
    const id = await insertJob(sql, { status: 'queued' });
    await runLedgerTick(sql);

    const [queued] = await sql`SELECT cells FROM ledger_rows WHERE row_key = ${`job:${id}`}`;
    assert.equal(queued.cells.Status, 'queued');
    assert.equal(queued.cells['Task ID'], '');

    // running → provider accepts → succeeded, exactly as processor.mjs does it.
    await sql`UPDATE jobs SET status = 'running' WHERE id = ${id}`;
    await runLedgerTick(sql);
    await sql`UPDATE jobs SET provider_task_id = 'cgt-xyz' WHERE id = ${id}`;
    await runLedgerTick(sql);
    await sql`UPDATE jobs SET status = 'succeeded', finished_at = now(),
        result = ${JSON.stringify({ video_key: 'videos/cgt-xyz.mp4' })}::jsonb WHERE id = ${id}`;
    await runLedgerTick(sql);

    const rows = await sql`SELECT row_key, cells FROM ledger_rows`;
    assert.equal(rows.length, 1, 'four writes, ONE row — the key never moved');
    assert.equal(rows[0].row_key, `job:${id}`);
    assert.equal(rows[0].cells.Status, 'succeeded');
    assert.equal(rows[0].cells['Task ID'], 'cgt-xyz');
    assert.equal(rows[0].cells['Storage Key (object path)'], 'videos/cgt-xyz.mp4');
    assert.equal(rows[0].cells['Storage State'], 'Confirmed — archived by server');
    assert.equal(rows[0].cells['Output Stored?'], 'Confirmed', 'the master workbook’s wording');
});

test('the row key survives the provider task id arriving — a coalesce key would not', async () => {
    const { sql } = await freshDb();
    const id = await insertJob(sql, { status: 'running' });
    await runLedgerTick(sql);
    await sql`UPDATE jobs SET provider_task_id = 'cgt-late' WHERE id = ${id}`;
    await runLedgerTick(sql);

    const keys = await sql`SELECT row_key FROM ledger_rows`;
    assert.deepEqual(keys.map((k) => k.row_key), [`job:${id}`]);
});

test('a late success demotes the earlier one, and both rows are re-queued', async () => {
    const { sql } = await freshDb();
    const first = await insertJob(sql, { status: 'succeeded', minutes: 0 });
    await runLedgerTick(sql);

    const [before] = await sql`SELECT cells FROM ledger_rows WHERE row_key = ${`job:${first}`}`;
    assert.equal(before.cells['Accepted Output'], 'YES');

    // Mark everything clean so re-dirtying is observable.
    await sql`UPDATE ledger_sync SET sync_state = 'clean'`;

    const second = await insertJob(sql, { status: 'succeeded', minutes: 5 });
    await runLedgerTick(sql);

    const rows = await sql`SELECT row_key, cells FROM ledger_rows ORDER BY submitted_at`;
    assert.equal(rows[0].cells['Accepted Output'], '', 'the earlier success must lose it');
    assert.equal(rows[1].cells['Accepted Output'], 'YES');
    assert.equal(rows.filter((r) => r.cells['Accepted Output'] === 'YES').length, 1);

    // The demoted row must be re-queued for Excel — the whole point of
    // expanding a change to its session.
    const dirty = await sql`SELECT row_key FROM ledger_sync
        WHERE target_id = 'master' AND sync_state = 'dirty' ORDER BY row_key`;
    const dirtyKeys = dirty.map((d) => d.row_key);
    assert.ok(dirtyKeys.includes(`job:${first}`), 'the demoted row must be rewritten to the sheet');
    assert.ok(dirtyKeys.includes(`job:${second}`));
});

test('an unchanged row is not re-queued, so a session recompute is cheap', async () => {
    const { sql } = await freshDb();
    await insertJob(sql, { status: 'succeeded' });
    await runLedgerTick(sql);
    await sql`UPDATE ledger_sync SET sync_state = 'clean'`;

    // Touch the job without changing anything the sheet renders.
    await sql`UPDATE jobs SET run_after = now()`;
    await runLedgerTick(sql);

    const dirty = await sql`SELECT count(*)::int AS n FROM ledger_sync WHERE sync_state = 'dirty'`;
    assert.equal(dirty[0].n, 0, 'identical cells must not dirty the workbook');
});

test('the watermark only advances past rows that were actually staged', async () => {
    const { sql } = await freshDb();
    assert.equal((await readWatermark(sql)).at.getTime(), 0);
    await insertJob(sql, { status: 'queued' });
    await runLedgerTick(sql);
    assert.ok((await readWatermark(sql)).at.getTime() > 0);
});

test('rows sharing one updated_at are paged THROUGH, not jumped over', async () => {
    // The migration case: adding jobs.updated_at stamps every pre-existing row
    // at once. With a bare timestamp cursor and a per-tick limit, the first
    // tick would read `limit` rows, move the cursor past that instant, and
    // strand the rest permanently. This is that scenario, in miniature.
    const { sql, db } = await freshDb();
    for (let i = 0; i < 10; i += 1) await insertJob(sql, { status: 'succeeded' });
    await forceUpdatedAt(db, sql, '2026-08-01 00:00:00+00');

    const [tied] = await sql`SELECT count(DISTINCT updated_at)::int AS n FROM jobs`;
    assert.equal(tied.n, 1, 'all ten rows must share one timestamp for this test to mean anything');

    let ticks = 0;
    while (ticks < 20) {
        const result = await runLedgerTick(sql, { limit: 3 });
        ticks += 1;
        if (!result.changed) break;
    }

    const staged = await sql`SELECT count(*)::int AS n FROM ledger_rows`;
    assert.equal(staged[0].n, 10, 'every tied row must eventually be staged');
    assert.ok(ticks > 1, 'and it must have taken several ticks, proving it paged');
});

test('the cursor carries the row key, so a tick resumes inside a tied block', async () => {
    const { sql, db } = await freshDb();
    for (let i = 0; i < 4; i += 1) await insertJob(sql, { status: 'succeeded' });
    await forceUpdatedAt(db, sql, '2026-08-01 00:00:00+00');

    await runLedgerTick(sql, { limit: 2 });
    const mid = await readWatermark(sql);
    assert.equal(mid.at.toISOString(), '2026-08-01T00:00:00.000Z');
    assert.ok(mid.key.startsWith('job:'), 'the cursor must remember WHICH row it stopped at');

    await runLedgerTick(sql, { limit: 2 });
    const staged = await sql`SELECT count(*)::int AS n FROM ledger_rows`;
    assert.equal(staged[0].n, 4);
});

test('a millisecond-tied block still advances — the cursor keeps Postgres microseconds', async () => {
    // Postgres stores microseconds; a JS Date stores milliseconds. A cursor
    // that round-trips through a Date rounds DOWN, landing back inside the
    // block it just consumed. With `limit` rows inside one millisecond that is
    // not a wasted re-read but a permanent stall: every tick reads the same
    // rows and writes back the same truncated cursor. Four rows, one
    // millisecond, four distinct microseconds.
    const { sql, db } = await freshDb();
    const ids = [];
    for (let i = 0; i < 4; i += 1) ids.push(await insertJob(sql, { status: 'succeeded' }));

    await db.query('ALTER TABLE jobs DISABLE TRIGGER jobs_set_updated_at');
    for (let i = 0; i < ids.length; i += 1) {
        await sql`UPDATE jobs SET updated_at = ${`2026-08-01 00:00:00.0001${i + 1}+00`}::timestamptz
            WHERE id = ${ids[i]}`;
    }
    await db.query('ALTER TABLE jobs ENABLE TRIGGER jobs_set_updated_at');

    const [tied] = await sql`SELECT count(DISTINCT date_trunc('milliseconds', updated_at))::int AS n
        FROM jobs`;
    assert.equal(tied.n, 1, 'all four rows must share one millisecond for this test to mean anything');

    await runLedgerTick(sql, { limit: 2 });
    const mid = await readWatermark(sql);
    assert.equal(
        mid.atText, '2026-08-01T00:00:00.000120Z',
        'the cursor must carry the microseconds Postgres compared on, not a Date’s rounding',
    );

    const second = await runLedgerTick(sql, { limit: 2 });
    assert.equal(second.changed, 2, 'the second tick must move PAST the first two, not re-read them');

    const staged = await sql`SELECT count(*)::int AS n FROM ledger_rows`;
    assert.equal(staged[0].n, 4, 'every row inside the tied millisecond must be staged');
});

test('the migration seeds updated_at from real history, not one shared instant', async () => {
    // Simulates the pre-v14 shape: a jobs table with no updated_at column, then
    // the v14 statements applied over it.
    const { db, sql } = await freshDb();
    // Pre-v14 had neither the column nor the trigger.
    await db.query('DROP TRIGGER IF EXISTS jobs_set_updated_at ON jobs');
    await db.query('ALTER TABLE jobs DROP COLUMN updated_at CASCADE');
    await sql`INSERT INTO jobs (project_id, user_id, model_id, status, request_body, created_at, finished_at)
        VALUES (1, 'u1', 'm', 'succeeded', '{}'::jsonb, timestamptz '2026-06-01 10:00:00+00', timestamptz '2026-06-01 10:05:00+00'),
               (1, 'u1', 'm', 'failed',    '{}'::jsonb, timestamptz '2026-07-01 10:00:00+00', timestamptz '2026-07-01 10:02:00+00')`;

    await db.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS updated_at timestamptz');
    await db.query('UPDATE jobs SET updated_at = coalesce(finished_at, started_at, created_at) WHERE updated_at IS NULL');
    await db.query('ALTER TABLE jobs ALTER COLUMN updated_at SET DEFAULT now()');
    await db.query('ALTER TABLE jobs ALTER COLUMN updated_at SET NOT NULL');

    const rows = await sql`SELECT updated_at FROM jobs ORDER BY updated_at`;
    assert.equal(rows.length, 2);
    assert.notEqual(
        new Date(rows[0].updated_at).getTime(),
        new Date(rows[1].updated_at).getTime(),
        'seeded rows must keep distinct timestamps, not all collapse to migration time',
    );
    assert.equal(new Date(rows[0].updated_at).toISOString(), '2026-06-01T10:05:00.000Z');
});

test('engagement reaches the ledger even though it never touches jobs', async () => {
    const { sql } = await freshDb();
    const id = await insertJob(sql, { status: 'succeeded', providerTaskId: 'cgt-dl' });
    await runLedgerTick(sql);
    const [before] = await sql`SELECT cells FROM ledger_rows WHERE row_key = ${`job:${id}`}`;
    assert.equal(before.cells['DOWNLOADED?'], 'no');

    await sql`INSERT INTO generation_events (task_id, user_id, event_type)
        VALUES ('cgt-dl', 'u1', 'download')`;
    await runLedgerTick(sql);

    const [after] = await sql`SELECT cells FROM ledger_rows WHERE row_key = ${`job:${id}`}`;
    assert.equal(after.cells['DOWNLOADED?'], 'YES');
    assert.equal(after.cells['Download Count'], 1);
    assert.equal(after.cells.Confidence, 'Recorded');
});
