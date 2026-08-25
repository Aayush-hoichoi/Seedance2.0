// The HTTP feed the Power Automate flow polls. These routes sit OUTSIDE the
// Clerk gate (middleware.js exempts /api/ledger), so the bearer check is the
// only thing standing between the prompt/cost history and the internet. It is
// tested accordingly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { GATEWAY_DDL } from '../lib/db/schema.mjs';
import { pendingRows, pendingCount, markManyClean, targetById } from '../lib/ledger/queue.mjs';
import { authorize, pendingFeed, acknowledge } from '../lib/ledger/feed.mjs';
import { LEDGER_COLUMNS } from '../lib/ledger/columns.mjs';

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
    sql.query = async (text, values = []) => (await db.query(text, values)).rows;
    return sql;
}

const PRE_GATEWAY_DDL = [
    `CREATE TABLE seedance_prompts (task_id text PRIMARY KEY, style text, user_prompt text,
        generated_prompt text, refs jsonb, liked boolean NOT NULL DEFAULT false,
        deleted boolean NOT NULL DEFAULT false, project_id integer,
        created_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE users (id text PRIMARY KEY, email text, name text, role text,
        created_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz)`,
    `CREATE TABLE usage_events (id serial PRIMARY KEY, user_id text NOT NULL, user_email text NOT NULL,
        model_id text NOT NULL, resolution text, duration integer, ratio text, mode text,
        has_video_input boolean NOT NULL DEFAULT false, task_id text, status text NOT NULL DEFAULT 'created',
        completion_tokens bigint, est_cost_usd numeric(10,4), cost_usd numeric(10,4),
        created_at timestamptz NOT NULL DEFAULT now(), finalized_at timestamptz, UNIQUE (task_id))`,
    `CREATE TABLE model_access_requests (id serial PRIMARY KEY, user_id text NOT NULL,
        user_email text NOT NULL, model_id text NOT NULL, status text NOT NULL, note text,
        decided_by text, created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz,
        expires_at timestamptz, project_id integer, max_resolution text, pending_max_resolution text)`,
];

async function seeded() {
    const db = new PGlite();
    for (const ddl of PRE_GATEWAY_DDL) await db.query(ddl);
    for (const ddl of GATEWAY_DDL) await db.query(ddl);
    const sql = neonLike(db);

    for (const [i, media] of ['Video', 'Video', 'Image'].entries()) {
        const key = `job:${i + 1}`;
        await sql`INSERT INTO ledger_rows (row_key, era, media, status, submitted_at, cells, source_at)
            VALUES (${key}, 'Gateway', ${media}, 'succeeded', now() + make_interval(mins => ${i}),
                    ${JSON.stringify({ 'Row Key': key, Media: media, Status: 'succeeded' })}, now())`;
        await sql`INSERT INTO ledger_sync (row_key, target_id, sync_state) VALUES (${key}, 'master', 'dirty')`;
        if (media === 'Video') {
            await sql`INSERT INTO ledger_sync (row_key, target_id, sync_state) VALUES (${key}, 'video', 'dirty')`;
        }
    }
    return sql;
}

test('each workbook sees only the rows that belong to it', async () => {
    const sql = await seeded();
    assert.equal(await pendingCount(sql, 'master'), 3);
    assert.equal(await pendingCount(sql, 'video'), 2, 'the image must not be queued for the video workbook');
});

test('pending rows come back oldest first, carrying their cells', async () => {
    const sql = await seeded();
    const rows = await pendingRows(sql, 'master', 10);
    assert.deepEqual(rows.map((r) => r.row_key), ['job:1', 'job:2', 'job:3']);
    assert.equal(rows[0].cells['Row Key'], 'job:1');
});

test('the limit is a page, not a filter — the rest stay queued', async () => {
    const sql = await seeded();
    const page = await pendingRows(sql, 'master', 2);
    assert.equal(page.length, 2);
    assert.equal(await pendingCount(sql, 'master'), 3, 'serving a page must not consume it');
});

test('acknowledging only the rows written leaves the rest to retry', async () => {
    const sql = await seeded();
    // A flow that wrote two rows and then died.
    const acked = await markManyClean(sql, 'master', ['job:1', 'job:2']);
    assert.equal(acked, 2);

    const left = await pendingRows(sql, 'master', 10);
    assert.deepEqual(left.map((r) => r.row_key), ['job:3'], 'the unwritten row must come back');
});

test('acknowledging one workbook does not clear the other', async () => {
    const sql = await seeded();
    await markManyClean(sql, 'master', ['job:1']);
    assert.equal(await pendingCount(sql, 'master'), 2);
    assert.equal(await pendingCount(sql, 'video'), 2, 'the video workbook still owes this row');
});

test('acknowledging the same row twice is harmless', async () => {
    const sql = await seeded();
    await markManyClean(sql, 'master', ['job:1']);
    const second = await markManyClean(sql, 'master', ['job:1']);
    assert.equal(second, 1, 'idempotent — a retried flow must not error');
    assert.equal(await pendingCount(sql, 'master'), 2);
});

test('an unknown row key acknowledges nothing rather than erroring', async () => {
    const sql = await seeded();
    assert.equal(await markManyClean(sql, 'master', ['job:does-not-exist']), 0);
    assert.equal(await pendingCount(sql, 'master'), 3);
});

test('targets resolve by id, and unknown ids do not', async () => {
    assert.equal(targetById('master').id, 'master');
    assert.equal(targetById('video').id, 'video');
    assert.equal(targetById('nope'), null);
});

test('the master workbook takes every media; the video one filters', async () => {
    const master = targetById('master');
    const video = targetById('video');
    assert.equal(master.filter({ media: 'Image' }), true);
    assert.equal(video.filter({ media: 'Image' }), false);
    assert.equal(video.filter({ media: 'Video' }), true);
});

function withSecret(secret, run) {
    const previous = process.env.CRON_SECRET;
    if (secret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = secret;
    try {
        return run();
    } finally {
        if (previous === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = previous;
    }
}

test('the feed refuses every request when CRON_SECRET is unset — fail closed', () => {
    withSecret(undefined, () => {
        const denied = authorize('Bearer anything');
        assert.ok(denied, 'an unset secret must LOCK the route, never open it');
        assert.equal(denied.status, 401);
    });
});

test('the feed refuses a wrong or missing bearer token', () => {
    withSecret('right-secret', () => {
        assert.equal(authorize(null).status, 401, 'no header');
        assert.equal(authorize('Bearer wrong').status, 401);
        assert.equal(authorize('right-secret').status, 401, 'the Bearer prefix is required');
        assert.equal(authorize('bearer right-secret').status, 401, 'the scheme is case-sensitive');
        assert.equal(authorize('Bearer right-secret'), null, 'the correct token passes');
    });
});

test('the feed rejects an unknown workbook rather than defaulting to one', async () => {
    const sql = await seeded();
    const result = await pendingFeed(sql, { target: 'not-a-workbook' });
    assert.equal(result.status, 400);
});

test('the feed returns flat, Excel-shaped rows plus the key to acknowledge', async () => {
    const sql = await seeded();
    const { body } = await pendingFeed(sql, { target: 'master', limit: 2 });
    assert.equal(body.count, 2);
    assert.equal(body.remaining, 1, 'a flow needs to know whether to loop again');
    assert.equal(body.rows[0]['Row Key'], 'job:1', 'column names match the workbook exactly');
    assert.equal(body.rows[0]._rowKey, 'job:1');
    // The feed serves the canonical superset — the SharePoint sync needs Row
    // Key, which neither workbook has. The console and the exports project it
    // down to 41 or 45.
    assert.deepEqual(body.columns, LEDGER_COLUMNS);
    assert.ok(body.columns.includes('Row Key'));
});

test('the feed clamps a silly limit instead of trusting it', async () => {
    const sql = await seeded();
    assert.equal((await pendingFeed(sql, { limit: '99999' })).body.count, 3);
    assert.equal((await pendingFeed(sql, { limit: '0' })).body.count, 3, 'falls back to the default');
    assert.equal((await pendingFeed(sql, { limit: 'abc' })).body.count, 3);
});

test('acknowledge accepts a single key or an array, and refuses neither', async () => {
    const sql = await seeded();
    assert.equal((await acknowledge(sql, { target: 'master', rowKey: 'job:1' })).body.acknowledged, 1);
    assert.equal((await acknowledge(sql, { target: 'master', rowKeys: ['job:2', 'job:3'] })).body.acknowledged, 2);
    assert.equal((await acknowledge(sql, { target: 'master' })).status, 400);
    assert.equal((await acknowledge(sql, null)).status, 400);
    assert.equal(await pendingCount(sql, 'master'), 0);
});

test('acknowledge de-duplicates repeated keys in one call', async () => {
    const sql = await seeded();
    const { body } = await acknowledge(sql, { target: 'master', rowKeys: ['job:1', 'job:1', 'job:1'] });
    assert.equal(body.requested, 1);
    assert.equal(body.acknowledged, 1);
});
