import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import { SCHEMA_VERSION } from '../lib/db/schema.mjs';

// Exercise the actual getDb, schema, and seeds, replacing only the Neon HTTP
// transport. Each import represents a fresh serverless process.
const stateKey = '__dbInitializationTest';
const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../lib/db/neon.js', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [{
        name: 'neon-test-transport',
        setup(builder) {
            builder.onResolve({ filter: /^@neondatabase\/serverless$/ }, () => ({ path: 'neon', namespace: 'db-test' }));
            builder.onLoad({ filter: /.*/, namespace: 'db-test' }, () => ({
                contents: `export const neon = (url) => globalThis.${stateKey}.connect(url);`,
                loader: 'js',
            }));
        },
    }],
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`;
let imports = 0;
const coldDb = async () => (await import(`${moduleUrl}#${imports++}`)).getDb;
const isVersionRead = (query) => query.includes("SELECT value FROM gateway_state WHERE key = 'schema.version'");
const isVersionWrite = (query) => query.includes("VALUES ('schema.version'");

function setup(t, execute = async (text) => isVersionRead(text) ? [{ value: { v: SCHEMA_VERSION } }] : []) {
    const previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://mock.invalid/gallery-startup';
    const state = { queries: [], connections: 0 };
    const query = async (text, values = []) => {
        state.queries.push({ text, values });
        return execute(text, values);
    };
    const sql = (strings, ...values) => query(strings.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, ''), values);
    sql.query = query;
    state.sql = sql;
    state.connect = () => { state.connections += 1; return sql; };
    globalThis[stateKey] = state;
    t.after(() => {
        if (previousUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousUrl;
        delete globalThis[stateKey];
    });
    return state;
}

test('current and newer databases need one read and no DDL on cold start', async (t) => {
    let version = SCHEMA_VERSION;
    const state = setup(t, async (text) => isVersionRead(text) ? [{ value: { v: version } }] : []);
    for (version of [SCHEMA_VERSION, SCHEMA_VERSION + 1]) {
        state.queries.length = 0;
        const getDb = await coldDb();
        assert.equal(await getDb(), state.sql);
        assert.equal(state.queries.length, 1, 'gallery startup must not replay bootstrap DDL');
        assert.ok(isVersionRead(state.queries[0].text));
        await getDb();
        assert.equal(state.queries.length, 1, 'warm requests reuse completed initialization');
    }
});

test('concurrent cold callers share the pending schema check', async (t) => {
    let release;
    const versionRead = new Promise((resolve) => { release = resolve; });
    const state = setup(t, async (text) => isVersionRead(text) ? versionRead : []);
    const getDb = await coldDb();
    const pending = [getDb(), getDb(), getDb()];
    // Let every caller reach the transport while the version read is blocked.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.connections, 1);
    assert.equal(state.queries.length, 1);
    release([{ value: { v: SCHEMA_VERSION } }]);
    assert.deepEqual(await Promise.all(pending), [state.sql, state.sql, state.sql]);
});

test('a failed version read surfaces without DDL and can be retried', async (t) => {
    const failure = Object.assign(new Error('database temporarily unavailable'), { code: '08006' });
    let unavailable = true;
    const state = setup(t, async (text) => {
        if (isVersionRead(text) && unavailable) throw failure;
        return isVersionRead(text) ? [{ value: { v: SCHEMA_VERSION } }] : [];
    });
    const getDb = await coldDb();
    const attempts = await Promise.allSettled([getDb(), getDb()]);
    assert.ok(attempts.every((result) => result.status === 'rejected' && result.reason === failure));
    assert.equal(state.queries.length, 1);
    assert.ok(isVersionRead(state.queries[0].text));
    unavailable = false;
    assert.equal(await getDb(), state.sql);
    assert.equal(state.queries.length, 2);
});

test('fresh and older databases still initialize real tables, views, and seeds', async (t) => {
    const db = new PGlite();
    t.after(() => db.close());
    const state = setup(t, async (text, values) => (await db.query(text, values)).rows);
    const freshGetDb = await coldDb();
    await freshGetDb();
    assert.ok(isVersionRead(state.queries[0].text), 'missing gateway_state is detected before bootstrap');
    assert.ok(isVersionWrite(state.queries.at(-1).text), 'version only advances after the whole migration');
    const version = async () => (await db.query("SELECT value FROM gateway_state WHERE key = 'schema.version'")).rows[0].value.v;
    assert.equal(await version(), SCHEMA_VERSION);
    assert.equal((await db.query("SELECT id FROM models WHERE id = 'seedance-2.0'")).rows.length, 1);
    await db.query('SELECT created_at, task_id FROM gallery_generations LIMIT 1');
    await db.query('SELECT submitted_at, finished_at FROM generation_ledger LIMIT 1');
    await db.query('SELECT pending_max_resolution FROM model_access_requests LIMIT 1');

    // Simulate an older schema that lacks a legacy bootstrap column. The
    // version-first fast path must still run that DDL when migration is due.
    await db.query('ALTER TABLE model_access_requests DROP COLUMN pending_max_resolution');
    await db.query("UPDATE gateway_state SET value = $1 WHERE key = 'schema.version'", [JSON.stringify({ v: SCHEMA_VERSION - 1 })]);
    await db.query("UPDATE providers SET display_name = 'Operator edit' WHERE id = 'byteplus'");
    state.queries.length = 0;
    const olderGetDb = await coldDb();
    await olderGetDb();
    assert.ok(isVersionRead(state.queries[0].text));
    assert.ok(isVersionWrite(state.queries.at(-1).text));
    assert.equal(await version(), SCHEMA_VERSION);
    await db.query('SELECT pending_max_resolution FROM model_access_requests LIMIT 1');
    assert.equal((await db.query("SELECT display_name FROM providers WHERE id = 'byteplus'")).rows[0].display_name, 'Operator edit');
});

test('failed migration leaves the old version intact and retries initialization', async (t) => {
    let version = SCHEMA_VERSION - 1;
    let failOnce = true;
    const failure = new Error('DDL temporarily blocked');
    const state = setup(t, async (text, values) => {
        if (isVersionRead(text)) return [{ value: { v: version } }];
        if (text.includes('CREATE TABLE IF NOT EXISTS seedance_prompts') && failOnce) {
            failOnce = false;
            throw failure;
        }
        if (isVersionWrite(text)) version = JSON.parse(values[0]).v;
        if (text.includes('INSERT INTO model_versions')) return [{ id: 1 }];
        return [];
    });
    const getDb = await coldDb();
    await assert.rejects(getDb(), (error) => error === failure);
    assert.equal(version, SCHEMA_VERSION - 1);
    assert.ok(!state.queries.some(({ text }) => isVersionWrite(text)));
    assert.equal(await getDb(), state.sql);
    assert.equal(version, SCHEMA_VERSION);
    assert.equal(state.queries.filter(({ text }) => isVersionRead(text)).length, 2);
    assert.ok(isVersionWrite(state.queries.at(-1).text));
});

test('unconfigured database returns null without creating a client', async (t) => {
    const state = setup(t);
    process.env.DATABASE_URL = ' ';
    const getDb = await coldDb();
    assert.equal(await getDb(), null);
    assert.equal(state.connections, 0);
    assert.deepEqual(state.queries, []);
});
