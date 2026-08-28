import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createIssueDecisionRouteHandler, createIssueRouteHandler } from '../lib/http/issueHandlers.mjs';
import { createIssueReport, decideIssueReport, listIssueReports } from '../lib/issueReports.mjs';
import { buildIssueCard } from '../lib/notify/teamsIssue.mjs';
import { visibleEvents } from '../lib/gateway/eventAudience.mjs';

const reporter = { userId: 'user-reporter', email: 'reporter@example.com', name: 'Reporting User', role: 'member' };
const teammate = { userId: 'user-teammate', email: 'teammate@example.com', name: 'Team Mate', role: 'member' };
const admin = { userId: 'user-admin', email: 'admin@example.com', name: 'Admin User', role: 'admin' };

function compile(strings, values) {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1]}`;
    return { text, values };
}

// Same Neon-shaped adapter the budget workflow tests use: lazy tokens so
// sql.transaction([...]) runs every statement on one PostgreSQL transaction.
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
    sql.transaction = (statements) => db.transaction(async (tx) => {
        const results = [];
        for (const statement of statements) results.push(await statement.execute(tx));
        return results;
    });
    return sql;
}

async function integrationDb() {
    const db = new PGlite();
    await db.exec(`
        CREATE TABLE projects (id serial PRIMARY KEY, name text NOT NULL, archived_at timestamptz);
        CREATE TABLE project_memberships (
            project_id integer NOT NULL, user_id text NOT NULL, role text,
            PRIMARY KEY (project_id, user_id)
        );
        CREATE TABLE model_versions (id text PRIMARY KEY, model_id text NOT NULL, version_tag text, kind text);
        CREATE TABLE models (
            id text PRIMARY KEY, display_name text NOT NULL, category text NOT NULL,
            active boolean NOT NULL DEFAULT true, current_version_id text
        );
        CREATE TABLE jobs (
            id serial PRIMARY KEY, project_id integer, user_id text, model_id text,
            status text, attempt integer, provider_id text, provider_task_id text,
            request_body jsonb, error jsonb,
            created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
        );
        CREATE TABLE audit_log (
            id bigserial PRIMARY KEY, actor_id text NOT NULL, actor_email text,
            action text NOT NULL, target_type text, target_id text,
            before jsonb, after jsonb, reason text, ip text,
            created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE events (
            id bigserial PRIMARY KEY, project_id integer, user_id text,
            type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_at timestamptz NOT NULL DEFAULT now()
        );

        INSERT INTO projects (id, name) VALUES (15, 'Launch Campaign');
        INSERT INTO project_memberships (project_id, user_id, role) VALUES
            (15, 'user-reporter', 'member'), (15, 'user-teammate', 'member');
        INSERT INTO model_versions (id, model_id, version_tag, kind)
            VALUES ('seedance-v2', 'seedance-2.0', 'seedance-2.0-250428', 'video');
        INSERT INTO models (id, display_name, category, current_version_id)
            VALUES ('seedance-2.0', 'Seedance 2.0', 'video', 'seedance-v2');
        INSERT INTO jobs
            (project_id, user_id, model_id, status, attempt, provider_id, provider_task_id, request_body, error)
            VALUES (15, 'user-reporter', 'seedance-2.0', 'failed', 2, 'byteplus', 'task-abc',
                    '{"options":{"resolution":"1080p"}}'::jsonb,
                    '{"message":"InternalServiceError: model overloaded","code":"500"}'::jsonb);
    `);
    return { db, sql: neonLike(db) };
}

function reportRoute(sql, user = reporter, onCreated = null) {
    return createIssueRouteHandler({
        authenticate: async () => user,
        createReport: (args) => createIssueReport({ ...args, sql }),
        onCreated,
    });
}

function decisionRoute(sql, user = admin) {
    return createIssueDecisionRouteHandler({
        authenticate: async () => user,
        canReview: (actor) => actor?.role === 'admin',
        decideReport: (args) => decideIssueReport({ ...args, sql }),
    });
}

const jsonRequest = (url, body) => new Request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const validReport = (overrides = {}) => ({
    projectId: 15,
    jobRef: { taskId: 'task-abc', clientJobId: 'job-local-1', mediaType: 'video' },
    modelId: 'seedance-2.0',
    attempts: { userRetries: 4, submitAttempts: 3 },
    error: 'Generation failed on the provider.',
    modeId: 'motion_capture',
    options: { resolution: '1080p', duration: 5 },
    prompt: 'a lighthouse in a storm',
    note: 'Fails every time with this reference image.',
    ...overrides,
});

test('a report captures the user, project, model, attempts and BOTH error sources', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());

    const unauthenticated = reportRoute(sql, null);
    assert.equal((await unauthenticated(jsonRequest('http://local/api/issues', validReport()))).status, 401);

    const response = await reportRoute(sql)(jsonRequest('http://local/api/issues', validReport()));
    assert.equal(response.status, 201, await response.clone().text());
    const { report } = await response.json();

    assert.equal(report.projectName, 'Launch Campaign');
    assert.equal(report.userName, 'Reporting User');
    assert.equal(report.userEmail, 'reporter@example.com');
    assert.equal(report.modelName, 'Seedance 2.0');
    assert.deepEqual(report.attempts, { userRetries: 4, submitAttempts: 3, serverAttempt: 2 });
    assert.equal(report.clientError, 'Generation failed on the provider.');
    // The half a browser can never see: the provider's own object off the job row.
    assert.equal(report.server.error.message, 'InternalServiceError: model overloaded');
    assert.equal(report.server.status, 'failed');
    assert.equal(report.server.providerId, 'byteplus');
    assert.equal(report.note, 'Fails every time with this reference image.');
});

test('a model referenced by its version tag still resolves to a display name', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    const response = await reportRoute(sql)(jsonRequest('http://local/api/issues',
        validReport({ modelId: 'seedance-2.0-250428' })));
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal((await response.json()).report.modelName, 'Seedance 2.0');
});

test('a failure that never reached a provider still reports, with no server half', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    const response = await reportRoute(sql)(jsonRequest('http://local/api/issues', validReport({
        jobRef: { clientJobId: 'job-local-never-submitted' },
        error: 'Failed to fetch',
    })));
    assert.equal(response.status, 201, await response.clone().text());
    const { report } = await response.json();
    assert.equal(report.server, null);
    assert.equal(report.clientError, 'Failed to fetch');
});

test('a job row belonging to someone else is never attached to a report', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    // The teammate claims the reporter's task id — enrichment is scoped to the
    // caller, so they get their own (empty) half, not someone else's logs.
    const response = await reportRoute(sql, teammate)(jsonRequest('http://local/api/issues', validReport()));
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal((await response.json()).report.server, null);
});

test('a non-member cannot report against a project, and an unidentifiable job is refused', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    const outsider = { userId: 'user-outsider', email: 'outsider@example.com', role: 'member' };
    const forbidden = await reportRoute(sql, outsider)(jsonRequest('http://local/api/issues', validReport()));
    assert.equal(forbidden.status, 403);

    const anonymousJob = await reportRoute(sql)(jsonRequest('http://local/api/issues',
        validReport({ jobRef: {} })));
    assert.equal(anonymousJob.status, 400);
    const [rows] = await sql`SELECT count(*)::int AS count FROM audit_log`;
    assert.equal(rows.count, 0);
});

test('pressing the button twice on one failure sends one card, not two', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    const sent = [];
    const route = reportRoute(sql, reporter, (result) => sent.push(result));

    const first = await route(jsonRequest('http://local/api/issues', validReport()));
    const second = await route(jsonRequest('http://local/api/issues', validReport({ note: 'again!' })));
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).duplicate, true);

    const [reports] = await sql`SELECT count(*)::int AS count FROM audit_log WHERE action = 'issue.reported'`;
    const [notifications] = await sql`SELECT count(*)::int AS count FROM events WHERE type = 'issue.reported'`;
    assert.equal(reports.count, 1);
    assert.equal(notifications.count, 1, 'a duplicate must not re-notify');
    assert.equal(sent.length, 1, 'and must not re-send the Teams card');

    // A genuinely new attempt is a new generation, so it is a new report.
    const retry = await route(jsonRequest('http://local/api/issues',
        validReport({ jobRef: { taskId: 'task-def', clientJobId: 'job-local-2' } })));
    assert.equal(retry.status, 201);
});

test('the report row and its notification commit or roll back together', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    await sql.query(`ALTER TABLE events ADD CONSTRAINT reject_issue_event CHECK (type <> 'issue.reported')`);

    const response = await reportRoute(sql)(jsonRequest('http://local/api/issues', validReport()));
    assert.equal(response.status, 503);
    const [rows] = await sql`SELECT count(*)::int AS count FROM audit_log`;
    assert.equal(rows.count, 0);
});

test('closing an issue is admin-only and one-shot', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    const created = await reportRoute(sql)(jsonRequest('http://local/api/issues', validReport()));
    const { id } = await created.json();

    const asMember = await decisionRoute(sql, teammate)(jsonRequest('http://local/resolve', {}), {
        params: Promise.resolve({ id, action: 'resolve' }),
    });
    assert.equal(asMember.status, 403);

    const unknownAction = await decisionRoute(sql)(jsonRequest('http://local/nope', {}), {
        params: Promise.resolve({ id, action: 'escalate' }),
    });
    assert.equal(unknownAction.status, 400);

    const missing = await decisionRoute(sql)(jsonRequest('http://local/resolve', {}), {
        params: Promise.resolve({ id: 'no-such-issue', action: 'resolve' }),
    });
    assert.equal(missing.status, 404);

    const resolved = await decisionRoute(sql)(jsonRequest('http://local/resolve', { note: 'Provider recovered' }), {
        params: Promise.resolve({ id, action: 'resolve' }),
    });
    assert.equal(resolved.status, 200, await resolved.clone().text());
    assert.equal((await resolved.json()).status, 'resolved');

    const again = await decisionRoute(sql)(jsonRequest('http://local/dismiss', {}), {
        params: Promise.resolve({ id, action: 'dismiss' }),
    });
    assert.equal(again.status, 409);

    const [listed] = await listIssueReports({ sql });
    assert.equal(listed.status, 'resolved');
    assert.equal(listed.decisionNote, 'Provider recovered');
    assert.equal(listed.decidedBy, 'admin@example.com');
    assert.equal(listed.modelName, 'Seedance 2.0');
});

test('the list puts open issues ahead of closed ones', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    const route = reportRoute(sql);
    const first = await (await route(jsonRequest('http://local/api/issues', validReport()))).json();
    await route(jsonRequest('http://local/api/issues', validReport({ jobRef: { taskId: 'task-def' } })));
    await decisionRoute(sql)(jsonRequest('http://local/dismiss', {}), {
        params: Promise.resolve({ id: first.id, action: 'dismiss' }),
    });

    const listed = await listIssueReports({ sql });
    assert.deepEqual(listed.map((item) => item.status), ['open', 'dismissed']);
});

test('issue notifications reach admins and the reporter, never a teammate', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    const created = await reportRoute(sql)(jsonRequest('http://local/api/issues', validReport()));
    const { id } = await created.json();
    await decisionRoute(sql)(jsonRequest('http://local/resolve', {}), {
        params: Promise.resolve({ id, action: 'resolve' }),
    });

    const audience = (user, isAdmin) => visibleEvents(sql, { cursor: 0, isAdmin, projectIds: [15], userId: user.userId })
        .then((rows) => rows.map((row) => row.type).sort());
    assert.deepEqual(await audience(admin, true), ['issue.decided', 'issue.reported']);
    assert.deepEqual(await audience(reporter, false), ['issue.decided', 'issue.reported']);
    assert.deepEqual(await audience(teammate, false), [], 'a colleague never sees another user’s failure');
});

test('the Teams card carries the provider error, the attempt count and no decision action', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    const created = await reportRoute(sql)(jsonRequest('http://local/api/issues', validReport()));
    const { report } = await created.json();

    const card = buildIssueCard(report);
    const flat = JSON.stringify(card);
    assert.match(flat, /InternalServiceError: model overloaded/);
    assert.match(flat, /4 tries · 3 submit retries · gateway attempt 2/);
    assert.match(flat, /Fails every time with this reference image\./);
    // A decision behind a card action or a URL is what let Safe Links decide
    // budget requests; an issue card must stay purely informational.
    assert.equal(card.actions.some((action) => action.type !== 'Action.OpenUrl'), false);
});

test('the card degrades to the client error when no gateway job matched', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    const created = await reportRoute(sql)(jsonRequest('http://local/api/issues', validReport({
        jobRef: { clientJobId: 'job-local-orphan' }, error: 'Failed to fetch', attempts: { userRetries: 1 },
    })));
    const card = buildIssueCard((await created.json()).report);
    const flat = JSON.stringify(card);
    assert.match(flat, /Failed to fetch/);
    assert.match(flat, /1 try/);
    assert.match(flat, /failed before it reached a provider/);
});

test('oversized client input is clamped, not stored whole', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    const created = await reportRoute(sql)(jsonRequest('http://local/api/issues', validReport({
        error: 'x'.repeat(9000), prompt: 'p'.repeat(5000), note: 'n'.repeat(2000),
        attempts: { userRetries: 999999, submitAttempts: -3 },
    })));
    const { report } = await created.json();
    assert.equal(report.clientError.length, 4000);
    assert.equal(report.prompt.length, 1000);
    assert.equal(report.note.length, 500);
    assert.equal(report.attempts.userRetries, 999);
    assert.equal(report.attempts.submitAttempts, null);
});
