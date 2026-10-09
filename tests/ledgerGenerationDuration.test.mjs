import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ledgerQuery } from '../lib/ledger/filters.mjs';
import { readGenerationDuration } from '../lib/ledger/generationDuration.mjs';

async function database(t) {
    const db = new PGlite();
    t.after(() => db.close());
    await db.exec(`
        CREATE TABLE ledger_rows (row_key text PRIMARY KEY, media text, cells jsonb);
        CREATE TABLE jobs (
            id integer PRIMARY KEY, request_body jsonb, status text, created_at timestamptz,
            finished_at timestamptz, model_id text, provider_id text, provider_task_id text
        );
    `);
    const sql = { query: async (text, values = []) => (await db.query(text, values)).rows };
    let sequence = 0;
    async function seed(overrides = {}) {
        const row = {
            media: 'Video', status: 'succeeded', start: '2026-10-09T04:30:00Z', seconds: 300,
            model: 'seedance-2.0', provider: 'bytedance', user: 'arpita@example.com',
            project: 'KauriBuri Series', prompt: 'Train at dusk', mode: '', ...overrides,
        };
        const id = `job:${++sequence}`;
        const day = row.start == null ? '' : new Date(new Date(row.start).getTime() + 330 * 60_000).toISOString().slice(0, 10);
        const finish = Object.hasOwn(overrides, 'finish') ? row.finish : row.start == null ? null : new Date(new Date(row.start).getTime() + row.seconds * 1000).toISOString();
        await sql.query('INSERT INTO ledger_rows VALUES ($1, $2, $3::jsonb)', [id, row.media, JSON.stringify({
            'Date (IST)': day, Model: row.model, 'User Email': row.user, Project: row.project,
            'PROMPT (exact)': row.prompt, 'Mode / Style': row.mode,
        })]);
        await sql.query('INSERT INTO jobs VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
            sequence, JSON.stringify({ category: row.media.toLowerCase() }), row.status, row.start, finish, row.model, row.provider, `task-${sequence}`,
        ]);
        return id;
    }
    const read = (options = {}) => readGenerationDuration(sql, ledgerQuery(options));
    return { sql, seed, read };
}

test('duration aggregation includes all matching pages and honours every ledger filter', async (t) => {
    const { sql, seed } = await database(t);
    for (let i = 0; i < 103; i++) await seed({ mode: 'tryon', seconds: i === 102 ? 900 : 300 });
    for (const mismatch of [
        { model: 'seedance-2.5' }, { user: 'other@example.com' }, { project: 'Other' },
        { prompt: 'Boat at dawn' }, { mode: '' }, { media: 'Image' }, { start: '2026-10-08T04:30:00Z' },
    ]) await seed({ mode: 'tryon', seconds: 1800, ...mismatch });

    const query = ledgerQuery({
        media: 'Video', q: 'Train', range: { from: '2026-10-09', to: '2026-10-09' },
        filters: { model: 'seedance-2.0', user: 'arpita@example.com', project: 'KauriBuri Series', mode: 'tryon' },
    });
    const aggregation = { rowsWhere: query.rowsWhere, values: [...query.values] };
    const page = await sql.query(`SELECT row_key FROM ledger_rows ${query.rowsWhere} ORDER BY row_key LIMIT ${query.bind(100)} OFFSET ${query.bind(100)}`, query.values);
    assert.equal(page.length, 3);
    const data = await readGenerationDuration(sql, aggregation);
    assert.equal(data.summary.completed, 103, 'pagination must not change analytics');
    assert.equal(data.summary.peakSeconds, 900, 'excluded records must not create a false peak');
    assert.equal(data.summary.averageSeconds, (102 * 300 + 900) / 103);
    assert.equal(data.summary.peakTask, 'task-103');
    assert.equal(data.summary.peakModel, 'seedance-2.0');
    assert.equal(data.summary.peakProvider, 'bytedance');
});

test('only successful videos with ordered, complete timestamps contribute', async (t) => {
    const { seed, read } = await database(t);
    await seed({ seconds: 0 });
    await seed({ seconds: 300 });
    for (const status of ['queued', 'running', 'failed', 'timed_out', 'cancelled', 'rejected']) await seed({ status, seconds: 900 });
    await seed({ media: 'Image', seconds: 900 });
    await seed({ start: null });
    await seed({ finish: null });
    await seed({ seconds: -1 });
    const result = await read();
    assert.equal(result.summary.completed, 2);
    assert.equal(result.summary.averageSeconds, 150);
    assert.equal(result.summary.peakSeconds, 300);
    const images = await read({ media: 'Image' });
    assert.equal(images.summary.completed, 0);
    assert.equal(images.summary.averageSeconds, null);
    assert.equal(images.summary.peakSeconds, null);
    assert.deepEqual(images.series, []);
});

test('IST date boundaries and 15-minute buckets follow submission, even when completion crosses midnight', async (t) => {
    const { seed, read } = await database(t);
    await seed({ start: '2026-10-08T18:29:59Z', seconds: 1200 }); // 8 Oct 23:59:59 IST
    await seed({ start: '2026-10-08T18:30:00Z', seconds: 300 }); // 9 Oct 00:00 IST
    await seed({ start: '2026-10-08T18:44:59Z', seconds: 600 }); // same 15m bucket
    await seed({ start: '2026-10-08T18:45:00Z', seconds: 900 }); // 00:15 IST
    await seed({ start: '2026-10-09T18:29:59Z', seconds: 600 }); // finishes on 10 Oct
    const data = await read({ range: { from: '2026-10-09', to: '2026-10-09' } });
    assert.equal(data.bucketSeconds, 900);
    assert.equal(data.summary.completed, 4);
    const populated = data.series.filter((point) => point.completed);
    assert.deepEqual(populated.map((point) => new Date(point.timestamp).toISOString()), [
        '2026-10-08T18:30:00.000Z', '2026-10-08T18:45:00.000Z', '2026-10-09T18:15:00.000Z',
    ]);
    assert.equal(populated[0].completed, 2);
    assert.equal(populated[0].averageMinutes, 7.5);
    assert.equal(populated[0].peakMinutes, 10);
    assert.equal(data.series[2].averageMinutes, null, 'idle intervals must not look like zero-minute jobs');
});

test('summary average is weighted by completed videos, not by bucket count', async (t) => {
    const { seed, read } = await database(t);
    await seed({ seconds: 60 });
    await seed({ seconds: 120 });
    await seed({ seconds: 180 });
    await seed({ start: '2026-10-09T04:45:00Z', seconds: 900, model: 'seedance-2.5', provider: 'other-provider' });
    const data = await read();
    assert.equal(data.summary.averageSeconds, 315);
    assert.equal(data.summary.peakSeconds, 900);
    assert.equal(data.summary.peakModel, 'seedance-2.5');
    assert.equal(data.summary.peakProvider, 'other-provider');
});

test('longer ranges use hourly then daily buckets anchored to IST', async (t) => {
    const { seed, read } = await database(t);
    await seed({ start: '2026-10-01T18:45:00Z' }); // 2 Oct 00:15 IST
    await seed({ start: '2026-10-04T19:15:00Z' }); // 5 Oct 00:45 IST
    let data = await read();
    assert.equal(data.bucketSeconds, 3600);
    assert.equal(new Date(data.series[0].timestamp).toISOString(), '2026-10-01T18:30:00.000Z');
    await seed({ start: '2026-10-20T23:15:00Z' });
    data = await read();
    assert.equal(data.bucketSeconds, 86400);
    assert.equal(new Date(data.series.at(-1).timestamp).toISOString(), '2026-10-20T18:30:00.000Z');
});

test('an empty view has no fabricated timing values', async (t) => {
    const { read } = await database(t);
    const data = await read();
    assert.equal(data.summary.completed, 0);
    assert.equal(data.summary.averageSeconds, null);
    assert.equal(data.summary.peakSeconds, null);
    assert.deepEqual(data.series, []);
});
