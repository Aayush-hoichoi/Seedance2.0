import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { GATEWAY_DDL } from '../lib/db/schema.mjs';
import { creatorOrderBy, queryCreators } from '../lib/access/galleryQueries.mjs';

let db;
const sql = { query: async (text, values = []) => (await db.query(text, values)).rows };

// Legacy tables created by getDb before the gateway schema. Use the actual
// gallery view and partial index rather than reproducing their predicates.
const legacyDdl = [
    `CREATE TABLE seedance_prompts (task_id text PRIMARY KEY, style text,
        user_prompt text, generated_prompt text, refs jsonb, liked boolean DEFAULT false,
        deleted boolean DEFAULT false, project_id integer, created_at timestamptz DEFAULT now())`,
    `CREATE TABLE users (id text PRIMARY KEY, email text, name text, role text,
        created_at timestamptz, updated_at timestamptz DEFAULT now(), deleted_at timestamptz)`,
    `CREATE TABLE usage_events (id serial PRIMARY KEY, user_id text NOT NULL,
        user_email text NOT NULL, model_id text NOT NULL, resolution text, duration integer,
        ratio text, mode text, has_video_input boolean DEFAULT false, task_id text UNIQUE,
        status text DEFAULT 'created', completion_tokens bigint, est_cost_usd numeric(10,4),
        cost_usd numeric(10,4), created_at timestamptz DEFAULT now(), finalized_at timestamptz)`,
    `CREATE TABLE model_access_requests (id serial PRIMARY KEY, user_id text, user_email text,
        model_id text, status text, note text, decided_by text, created_at timestamptz,
        decided_at timestamptz, expires_at timestamptz, project_id integer,
        max_resolution text, pending_max_resolution text)`,
];

async function job(userId, taskId, { status = 'succeeded', category = 'video', mode = 'reference', result = {}, created = '2026-10-01T10:00:00Z', started = null } = {}) {
    await sql.query(`INSERT INTO jobs (project_id, user_id, model_id, status, provider_task_id,
        request_body, result, created_at, started_at) VALUES (1, $1, 'seedance-2.0', $2, $3, $4, $5, $6, $7)`,
    [userId, status, taskId, JSON.stringify({ category, options: { mode } }), JSON.stringify(result), created, started]);
}

async function legacy(userId, taskId, { status = 'succeeded', mode = 'reference', email = `${userId}@example.com`, created = '2026-10-02T10:00:00Z' } = {}) {
    await sql.query(`INSERT INTO usage_events (user_id, user_email, model_id, task_id, status, mode, created_at)
        VALUES ($1, $2, 'legacy-model', $3, $4, $5, $6)`, [userId, email, taskId, status, mode, created]);
}

const originalQuery = (order) => `SELECT coalesce(u.id, s.user_id) AS id,
        coalesce(u.name, split_part(coalesce(u.email, s.user_email), '@', 1)) AS name,
        coalesce(u.email, s.user_email) AS email, u.role,
        coalesce(s.generations, 0)::int AS generations, s.last_at
    FROM users u FULL OUTER JOIN (
        SELECT user_id, max(user_email) AS user_email,
            count(*) FILTER (WHERE status <> 'failed' AND coalesce(mode, '') <> 'tryon') AS generations,
            max(created_at) FILTER (WHERE status <> 'failed' AND coalesce(mode, '') <> 'tryon') AS last_at
        FROM gallery_generations GROUP BY user_id
    ) s ON s.user_id = u.id
    WHERE u.deleted_at IS NULL OR u.id IS NULL
    ORDER BY ${creatorOrderBy(order)}`;

before(async () => {
    db = new PGlite();
    for (const ddl of [...legacyDdl, ...GATEWAY_DDL]) await db.query(ddl);
    await db.query(`INSERT INTO users (id, name, email, role, created_at, deleted_at) VALUES
        ('alpha', 'Alpha', 'alpha@example.com', 'member', '2025-01-01', NULL),
        ('beta', NULL, 'beta@example.com', 'member', '2025-01-02', NULL),
        ('fallback', NULL, NULL, NULL, '2025-01-03', NULL),
        ('never', 'Never generated', 'never@example.com', NULL, '2025-01-04', NULL),
        ('failed', 'Failed only', 'failed@example.com', NULL, '2025-01-05', NULL),
        ('deleted', 'Deleted user', 'deleted@example.com', NULL, '2025-01-06', now())`);
    await job('alpha', 'video-binned', { started: '2026-10-03T10:00:00Z' });
    await sql.query("INSERT INTO seedance_prompts (task_id, deleted) VALUES ('video-binned', true)");
    await job('alpha', null, { category: 'image', result: { images: [{ key: 'images/key.png' }, { key: 'images/second.png' }] } });
    await job('alpha', null, { category: 'image', result: { images: [{ url: 'https://example.com/image.png' }] } });
    await job('alpha', null, { category: 'image' });
    await job('alpha', null, { result: { video_url: 'https://example.com/video.mp4' } });
    await job('alpha', 'failed-latest', { status: 'failed', created: '2026-10-09T10:00:00Z' });
    await job('alpha', 'tryon-latest', { mode: 'tryon', created: '2026-10-08T10:00:00Z' });
    await job('beta', 'running-video', { status: 'running', mode: null, created: '2026-10-04T10:00:00Z' });
    await job('beta', 'non-string-mode', { mode: ['tryon'] });
    await job('failed', 'only-failure', { status: 'failed' });
    await job('deleted', 'deleted-video', { created: '2026-10-10T10:00:00Z' });
    await job('orphan-failed', 'orphan-failed-video', { status: 'failed' });
    await job('orphan-tryon', 'orphan-tryon-video', { mode: 'tryon' });
    await job('orphan-invisible', null, { category: 'image' });
    await job('mixed', 'mixed-video');
    await legacy('alpha', 'video-binned');
    await legacy('mismatched-owner', 'running-video');
    await legacy('alpha', 'alpha-legacy');
    await legacy('fallback', 'fallback-failure', { status: 'failed', email: 'fallback-email@example.com' });
    await legacy('mixed', 'mixed-legacy', { status: 'created', email: 'a@example.com' });
    await legacy('mixed', 'mixed-legacy-failed', { status: 'failed', email: 'z@example.com', created: '2026-10-10T10:00:00Z' });
    await legacy('legacy-failed', 'legacy-failed-task', { status: 'failed' });
    await legacy('legacy-tryon', 'legacy-tryon-task', { mode: 'tryon' });
    await legacy('legacy-invisible', null);
});

after(async () => db?.close());

test('optimized roster matches the view across all visibility and identity cases', async () => {
    const byId = (rows) => rows.toSorted((a, b) => a.id.localeCompare(b.id));
    for (const order of ['recent', 'volume']) {
        assert.deepEqual(byId(await queryCreators(sql, { order })), byId(await sql.query(originalQuery(order))));
    }
    const rows = new Map((await queryCreators(sql)).map((row) => [row.id, row]));
    assert.equal(rows.get('alpha').generations, 4, 'binned video, both image shapes, and unmatched legacy video count');
    assert.equal(rows.get('alpha').last_at.toISOString(), '2026-10-03T10:00:00.000Z', 'queue start determines activity; failures and Try-On do not');
    assert.equal(rows.get('beta').generations, 2, 'non-string mode is not the literal Try-On mode');
    assert.equal(rows.get('mixed').generations, 2);
    assert.equal(rows.get('mixed').email, 'z@example.com', 'failed rows still participate in legacy email fallback');
    assert.equal(rows.get('fallback').name, 'fallback-email');
    for (const id of ['never', 'failed', 'orphan-failed', 'orphan-tryon', 'legacy-failed', 'legacy-tryon']) {
        assert.equal(rows.get(id).generations, 0, id);
        assert.equal(rows.get(id).last_at, null, id);
    }
    for (const id of ['deleted', 'orphan-invisible', 'legacy-invisible', 'mismatched-owner']) assert.ok(!rows.has(id), id);
});

test('recent and volume preserve their ordering keys and reject arbitrary SQL', async () => {
    const recent = await queryCreators(sql, { order: 'recent' });
    const volume = await queryCreators(sql, { order: 'volume' });
    assert.equal(recent[0].id, 'beta');
    assert.equal(volume[0].id, 'alpha');
    assert.deepEqual(await queryCreators(sql, { order: '; DROP TABLE users' }), volume);
    // Zero-count orphan rows have identical sort keys; compare the ranked
    // prefix separately rather than demanding an undefined tie order.
    for (const order of ['recent', 'volume']) {
        const ids = (rows) => rows.filter((row) => row.generations > 0).map((row) => row.id);
        assert.deepEqual(ids(await queryCreators(sql, { order })), ids(await sql.query(originalQuery(order))));
    }
});

test('roster aggregates use the covering index without reading request payloads', async () => {
    // Enough rows and realistic inline reference payloads to let the planner
    // choose naturally; do not force enable_seqscan=off to fake an index win.
    await db.query(`INSERT INTO jobs (project_id, user_id, model_id, status, provider_task_id, request_body, created_at)
        SELECT 1, 'alpha', 'seedance-2.0', 'succeeded', 'bulk-' || n,
            jsonb_build_object('category', 'video', 'options', jsonb_build_object('mode', 'reference'),
                'reference', repeat(md5(n::text), 400)), '2026-09-01'::timestamptz
        FROM generate_series(1, 8000) n`);
    await db.exec('VACUUM ANALYZE jobs');
    await db.exec('ANALYZE users');
    await db.exec('ANALYZE usage_events');
    let query;
    await queryCreators({ query: async (text) => { query = text; return []; } });
    const [explain] = await sql.query(`EXPLAIN (FORMAT JSON) ${query}`);
    const nodes = [];
    const visit = (node) => { nodes.push(node); for (const child of node.Plans || []) visit(child); };
    visit(explain['QUERY PLAN'][0].Plan);
    assert.ok(nodes.some((node) => node['Node Type'] === 'Index Only Scan' && node['Index Name'] === 'jobs_gallery_creator_summary'),
        JSON.stringify(explain));
    // JSON visibility for historical unknown identities stays after the
    // materialized anti-join instead of touching every known user's job.
    assert.ok(nodes.some((node) => node['Node Type'] === 'CTE Scan' && node['CTE Name'] === 'orphan_jobs'));
    const byId = (rows) => rows.toSorted((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(byId(await queryCreators(sql)), byId(await sql.query(originalQuery('volume'))));
});
