// The ledger console's filters: the predicates, and the SQL they become.
//
// Run against a real Postgres (PGlite) rather than asserting on query strings,
// because the two things worth proving here are behavioural: that a dropdown
// only ever offers values that return rows, and that picking one returns
// exactly those rows and no near-misses.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
    readFilters, ledgerPredicates, ledgerQuery, facetQuery, FILTER_COLUMNS,
    readSort, orderBy, LEDGER_SORTS, DEFAULT_SORT,
} from '../lib/ledger/filters.mjs';

function neonLike(db) {
    const sql = async (text, values = []) => (await db.query(text, values)).rows;
    return { query: sql };
}

async function freshDb() {
    const db = new PGlite();
    await db.query(`CREATE TABLE ledger_rows (
        row_key      text PRIMARY KEY,
        era          text NOT NULL,
        media        text NOT NULL,
        status       text,
        submitted_at timestamptz,
        session_id   text,
        cells        jsonb NOT NULL,
        source_at    timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now()
    )`);
    return { db, sql: neonLike(db) };
}

let seq = 0;
async function seed(sql, { media = 'Video', model, user, name, project, prompt = 'a train at dusk' }) {
    seq += 1;
    const cells = {
        Model: model,
        'User Email': user,
        'User Name': name ?? user,
        Project: project,
        'PROMPT (exact)': prompt,
        Media: media,
    };
    await sql.query(
        `INSERT INTO ledger_rows (row_key, era, media, submitted_at, cells, source_at)
         VALUES ($1, 'Gateway', $2, now(), $3::jsonb, now())`,
        [`job:${seq}`, media, JSON.stringify(cells)],
    );
}

async function listed(sql, opts) {
    const { rowsWhere, values, bind } = ledgerQuery(opts);
    return sql.query(
        `SELECT cells FROM ledger_rows ${rowsWhere}
         ORDER BY row_key LIMIT ${bind(100)} OFFSET ${bind(0)}`,
        values,
    );
}

test('readFilters takes the three columns and drops blanks', () => {
    const params = new URLSearchParams('model=seedance-2.0&user=&project=%20%20&q=ignored');
    assert.deepEqual(readFilters(params), { model: 'seedance-2.0' });
});

test('no filters means no predicates — the unfiltered list stays unfiltered', () => {
    const bind = () => '$1';
    assert.deepEqual(ledgerPredicates({}, bind), []);
    assert.equal(ledgerQuery({}).where, '');
});

test('every filter binds its value rather than inlining it', () => {
    const { values } = ledgerQuery({
        q: "'; DROP TABLE ledger_rows; --",
        filters: { model: "also' unsafe", user: 'a@b.tv', project: 'P' },
    });
    // q, model, user, project, media — five bound values, nothing interpolated.
    assert.deepEqual(values, ["'; DROP TABLE ledger_rows; --", "also' unsafe", 'a@b.tv', 'P', null]);
});

test('a model filter is exact, so a longer name is not swept in with it', async () => {
    const { sql } = await freshDb();
    await seed(sql, { model: 'seedance-1.0', user: 'a@b.tv', project: 'P' });
    await seed(sql, { model: 'seedance-1.0-pro', user: 'a@b.tv', project: 'P' });

    const rows = await listed(sql, { filters: { model: 'seedance-1.0' } });
    assert.equal(rows.length, 1, 'seedance-1.0-pro must NOT match seedance-1.0');
    assert.equal(rows[0].cells.Model, 'seedance-1.0');
});

test('the user filter keys on the address, so a shared display name cannot merge two people', async () => {
    const { sql } = await freshDb();
    await seed(sql, { model: 'm', user: 'sayan.maiti@hoichoi.tv', name: 'Sayan Maiti', project: 'P' });
    await seed(sql, { model: 'm', user: 'sayan.m@partner.example', name: 'Sayan Maiti', project: 'P' });

    assert.equal(FILTER_COLUMNS.user, 'User Email');
    const rows = await listed(sql, { filters: { user: 'sayan.maiti@hoichoi.tv' } });
    assert.equal(rows.length, 1, 'two people share the name; only one has the address');
    assert.equal(rows[0].cells['User Email'], 'sayan.maiti@hoichoi.tv');
});

test('the three filters combine with AND, not OR', async () => {
    const { sql } = await freshDb();
    await seed(sql, { model: 'm1', user: 'a@b.tv', project: 'Alpha' });
    await seed(sql, { model: 'm1', user: 'c@d.tv', project: 'Alpha' });
    await seed(sql, { model: 'm2', user: 'a@b.tv', project: 'Alpha' });
    await seed(sql, { model: 'm1', user: 'a@b.tv', project: 'Beta' });

    const rows = await listed(sql, {
        filters: { model: 'm1', user: 'a@b.tv', project: 'Alpha' },
    });
    assert.equal(rows.length, 1, 'only the row matching all three');
    assert.equal(rows[0].cells.Project, 'Alpha');
});

test('free text and the dropdowns narrow together', async () => {
    const { sql } = await freshDb();
    await seed(sql, { model: 'm1', user: 'a@b.tv', project: 'P', prompt: 'a train at dusk' });
    await seed(sql, { model: 'm1', user: 'a@b.tv', project: 'P', prompt: 'a boat at dawn' });

    const rows = await listed(sql, { q: 'train', filters: { model: 'm1' } });
    assert.equal(rows.length, 1);
    assert.match(rows[0].cells['PROMPT (exact)'], /train/);
});

test('the media scope is separable, so the tab badges can ignore the tab', async () => {
    const { sql } = await freshDb();
    await seed(sql, { media: 'Video', model: 'm1', user: 'a@b.tv', project: 'P' });
    await seed(sql, { media: 'Image', model: 'm1', user: 'a@b.tv', project: 'P' });
    await seed(sql, { media: 'Image', model: 'm2', user: 'a@b.tv', project: 'P' });

    const { where, mediaTest, values } = ledgerQuery({ filters: { model: 'm1' }, media: 'Video' });
    const [counts] = await sql.query(
        `SELECT count(*) FILTER (WHERE ${mediaTest})::int AS total,
                count(*) FILTER (WHERE media = 'Image')::int AS images,
                count(*) FILTER (WHERE media = 'Video')::int AS videos
         FROM ledger_rows ${where}`,
        values,
    );
    // total honours the Video tab; the badges report what the filter alone
    // matches, which is how you can tell the Image tab is worth clicking.
    assert.equal(counts.total, 1, 'the Video tab, filtered to m1');
    assert.equal(counts.images, 1, 'm1 also has an image — badge must say so');
    assert.equal(counts.videos, 1);
});

test('a facet offers every value that occurs, with its count, commonest first', async () => {
    const { sql } = await freshDb();
    await seed(sql, { model: 'seedance-2.0', user: 'a@b.tv', project: 'P' });
    await seed(sql, { model: 'seedance-2.0', user: 'a@b.tv', project: 'P' });
    await seed(sql, { model: 'nano-banana-pro', user: 'a@b.tv', project: 'P' });

    const { text, values } = facetQuery('model');
    const rows = await sql.query(text, values);
    assert.deepEqual(rows.map((r) => [r.value, r.count]), [
        ['seedance-2.0', 2],
        ['nano-banana-pro', 1],
    ]);
});

test('the user facet shows the name but returns the address to filter on', async () => {
    const { sql } = await freshDb();
    await seed(sql, { model: 'm', user: 'shinjini.nandy@hoichoi.tv', name: 'Shinjini Nandy', project: 'P' });

    const { text, values } = facetQuery('user', { labelColumn: 'User Name' });
    const [row] = await sql.query(text, values);
    assert.equal(row.value, 'shinjini.nandy@hoichoi.tv', 'the value is what the filter matches');
    assert.equal(row.label, 'Shinjini Nandy', 'the label is what the admin reads');
});

test('a media-scoped facet never offers a value that would return nothing', async () => {
    const { sql } = await freshDb();
    await seed(sql, { media: 'Image', model: 'nano-banana-pro', user: 'a@b.tv', project: 'P' });
    await seed(sql, { media: 'Video', model: 'seedance-2.0', user: 'a@b.tv', project: 'P' });

    const { text, values } = facetQuery('model', { media: 'Video' });
    const offered = (await sql.query(text, values)).map((r) => r.value);
    assert.deepEqual(offered, ['seedance-2.0'],
        'the video workbook must not offer an image-only model');

    // And the promise the dropdown makes: every option it offers returns rows.
    for (const model of offered) {
        const rows = await listed(sql, { filters: { model }, media: 'Video' });
        assert.ok(rows.length > 0, `${model} was offered but matches nothing`);
    }
});

test('facetQuery refuses a column that is not filterable', () => {
    assert.throws(() => facetQuery('prompt'), /Not a filterable column/);
});

test('the sort key resolves through a fixed map, so a request cannot inject SQL', () => {
    const hostile = new URLSearchParams("sort=submitted_at; DROP TABLE ledger_rows--");
    assert.equal(readSort(hostile), DEFAULT_SORT, 'an unknown sort must fall back, not pass through');
    assert.equal(readSort(new URLSearchParams('sort=oldest')), 'oldest');
    assert.equal(readSort(new URLSearchParams('')), DEFAULT_SORT);

    // Prototype keys must not resolve either — Object.hasOwn, not `in`.
    assert.equal(readSort(new URLSearchParams('sort=constructor')), DEFAULT_SORT);
    assert.equal(readSort(new URLSearchParams('sort=toString')), DEFAULT_SORT);

    // orderBy never returns anything but one of ours.
    const known = Object.values(LEDGER_SORTS).map((s) => s.sql);
    assert.ok(known.includes(orderBy('nonsense')));
    assert.ok(known.includes(orderBy(undefined)));
});

test('newest and oldest really do reverse the table', async () => {
    const { sql } = await freshDb();
    for (let i = 0; i < 4; i += 1) {
        await seed(sql, { model: 'm1', user: 'a@b.tv', project: 'P' });
    }
    // Explicit, distinct timestamps. Relying on four now() calls landing on
    // four different instants is how a test starts flaking on a fast machine.
    const keys = (await sql.query('SELECT row_key FROM ledger_rows ORDER BY row_key')).map((r) => r.row_key);
    for (let i = 0; i < keys.length; i += 1) {
        await sql.query(
            `UPDATE ledger_rows SET submitted_at = $1::timestamptz WHERE row_key = $2`,
            [`2026-08-01 0${i}:00:00+00`, keys[i]],
        );
    }

    const read = async (sort) => (await sql.query(
        `SELECT submitted_at FROM ledger_rows ORDER BY ${orderBy(sort)}`,
    )).map((r) => new Date(r.submitted_at).getTime());

    const newest = await read('newest');
    const oldest = await read('oldest');
    assert.deepEqual(newest, [...oldest].reverse());
    assert.ok(newest[0] > newest[3], 'newest first really is descending');
    assert.ok(oldest[0] < oldest[3], 'oldest first really is ascending');
});

test('rows sharing a timestamp page without repeating or skipping one', async () => {
    // A retry burst can put several rows on one instant. If the row_key
    // tiebreaker did not run the SAME direction as the timestamp, a row could
    // land on two pages, or on none, as the admin pages through.
    const { sql } = await freshDb();
    const at = '2026-08-01 00:00:00+00';
    for (let i = 0; i < 6; i += 1) {
        await seed(sql, { model: 'm1', user: 'a@b.tv', project: 'P' });
    }
    await sql.query('UPDATE ledger_rows SET submitted_at = $1::timestamptz', [at]);

    for (const sort of ['newest', 'oldest']) {
        const seen = [];
        for (let offset = 0; offset < 6; offset += 2) {
            const page = await sql.query(
                `SELECT row_key FROM ledger_rows ORDER BY ${orderBy(sort)} LIMIT 2 OFFSET ${offset}`,
            );
            seen.push(...page.map((r) => r.row_key));
        }
        assert.equal(seen.length, 6, `${sort}: every row appears`);
        assert.equal(new Set(seen).size, 6, `${sort}: and none appears twice`);
    }
});
