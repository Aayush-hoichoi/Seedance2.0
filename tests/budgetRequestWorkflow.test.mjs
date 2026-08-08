import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createBudgetDecisionRouteHandler, createBudgetRequestRouteHandlers, createMyBudgetRouteHandler } from '../lib/http/budgetRequestHandlers.mjs';
import { createBudgetRequest, decideBudgetRequest, getBudgetRequestContext, nextApprovedLimit } from '../lib/budgetRequests.mjs';
import { activeQuotas, changeQuotaCapSafely, reserveBillingEvent, usageForQuotas } from '../lib/gateway/db.js';
import { effectiveAccess } from '../lib/gateway/access.mjs';
import { visibleEvents } from '../lib/gateway/eventAudience.mjs';
import { resolutionWithinTier, RESOLUTIONS } from '../lib/seedance/constants.js';

const requester = { userId: 'user-requester', email: 'requester@example.com', name: 'Requesting User', role: 'member' };
const teammate = { userId: 'user-teammate', email: 'teammate@example.com', name: 'Team Mate', role: 'member' };
const admin = { userId: 'user-admin', email: 'admin@example.com', name: 'Admin User', role: 'admin' };

function compile(strings, values) {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1]}`;
    return { text, values };
}

// Adapts PGlite to the small Neon tagged-query surface used by production.
// Query tokens are lazy so sql.transaction([...]) executes every statement on
// the same PostgreSQL transaction and rolls the entire workflow back on error.
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
        CREATE TABLE projects (
            id serial PRIMARY KEY, name text NOT NULL, archived_at timestamptz
        );
        CREATE TABLE project_memberships (
            project_id integer NOT NULL, user_id text NOT NULL, role text,
            PRIMARY KEY (project_id, user_id)
        );
        CREATE TABLE model_versions (
            id text PRIMARY KEY, model_id text NOT NULL, version_tag text, kind text
        );
        CREATE TABLE models (
            id text PRIMARY KEY, display_name text NOT NULL, category text NOT NULL,
            active boolean NOT NULL DEFAULT true, current_version_id text
        );
        CREATE TABLE billing_events (
            id serial PRIMARY KEY, event_type text NOT NULL, generation_id text,
            project_id integer, user_id text, model_id text, model_version_id text,
            provider_id text, api_key_id integer,
            cost_usd numeric, est_cost_usd numeric, units jsonb, pricing_snapshot jsonb,
            created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE quotas (
            id serial PRIMARY KEY, project_id integer, user_id text, model_id text,
            type text NOT NULL, "window" text NOT NULL, hard_limit numeric NOT NULL,
            policy text NOT NULL DEFAULT 'hard', soft_overage_pct numeric NOT NULL DEFAULT 0,
            alert_thresholds integer[] NOT NULL DEFAULT ARRAY[80,90,100],
            created_by text, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
        );
        CREATE TABLE user_model_overrides (
            id serial PRIMARY KEY, project_id integer NOT NULL, user_id text NOT NULL,
            model_id text NOT NULL, effect text NOT NULL, max_resolution text,
            valid_from timestamptz, valid_until timestamptz, created_by text, revoked_at timestamptz
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
            (15, 'user-requester', 'member'), (15, 'user-teammate', 'member');
        INSERT INTO model_versions (id, model_id, version_tag, kind)
            VALUES ('seedance-v2', 'seedance-2.0', 'seedance-2.0-250428', 'video');
        INSERT INTO models (id, display_name, category, current_version_id)
            VALUES ('seedance-2.0', 'Seedance 2.0', 'video', 'seedance-v2');
        INSERT INTO billing_events
            (event_type, generation_id, project_id, user_id, model_id, cost_usd)
            VALUES ('settlement', 'generation-1', 15, 'user-requester', 'seedance-2.0', 30);
        INSERT INTO quotas
            (project_id, user_id, model_id, type, "window", hard_limit, policy, created_by)
            VALUES (15, 'user-requester', 'seedance-2.0', 'usd', 'monthly', 100, 'hard', 'user-admin');
    `);
    return { db, sql: neonLike(db) };
}

function userRoutes(sql, user = requester) {
    return createBudgetRequestRouteHandlers({
        authenticate: async () => user,
        loadContext: (args) => getBudgetRequestContext({ ...args, sql }),
        createRequest: (args) => createBudgetRequest({ ...args, sql }),
    });
}

function decisionRoute(sql, user = admin) {
    return createBudgetDecisionRouteHandler({
        authenticate: async () => user,
        canReview: (actor) => actor?.role === 'admin',
        decideRequest: (args) => decideBudgetRequest({ ...args, sql }),
    });
}

function budgetRoute(sql, user = requester) {
    return createMyBudgetRouteHandler({
        authorize: async () => ({ ok: true, ctx: { sql, user } }),
        loadActiveQuotas: activeQuotas,
        loadUsage: usageForQuotas,
    });
}

function jsonRequest(url, body) {
    return new Request(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
}

test('authenticated budget workflow persists quota/access, reports remaining budget, and keeps notifications private', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());

    const unauthenticated = userRoutes(sql, null);
    assert.equal((await unauthenticated.POST(jsonRequest('http://local/api/budget-requests', {}))).status, 401);

    const memberRoutes = userRoutes(sql);
    const requestResponse = await memberRoutes.POST(jsonRequest('http://local/api/budget-requests', {
        projectId: 15,
        modelId: 'seedance-2.0',
        quality: '1080p',
        increaseAmount: 50,
        reason: 'Final launch renders',
    }));
    assert.equal(requestResponse.status, 201, await requestResponse.clone().text());
    const requested = await requestResponse.json();

    // Reproduce the stale-cap race after submission and before approval.
    await sql`UPDATE quotas SET hard_limit = 200 WHERE project_id = 15 AND user_id = ${requester.userId}`;

    const nonAdminDecision = decisionRoute(sql, teammate);
    assert.equal((await nonAdminDecision(jsonRequest('http://local/deny', { policy: 'hard' }), {
        params: Promise.resolve({ id: requested.id, action: 'approve' }),
    })).status, 403);

    const approve = decisionRoute(sql);
    const approvalResponse = await approve(jsonRequest('http://local/approve', { policy: 'hard' }), {
        params: Promise.resolve({ id: requested.id, action: 'approve' }),
    });
    assert.equal(approvalResponse.status, 200);
    assert.equal((await approvalResponse.json()).limit, 250);

    const [quota] = await sql`SELECT * FROM quotas WHERE project_id = 15 AND user_id = ${requester.userId} AND model_id = 'seedance-2.0' AND deleted_at IS NULL`;
    assert.equal(Number(quota.hard_limit), 250);

    const [override] = await sql`SELECT * FROM user_model_overrides WHERE project_id = 15 AND user_id = ${requester.userId} AND model_id = 'seedance-2.0'`;
    const access = effectiveAccess({ modelId: 'seedance-2.0', overrides: [override], grants: [], defaultModelIds: [], now: new Date() });
    assert.deepEqual(access, { allowed: true, rule: 'allow_override', maxResolution: '1080p' });
    assert.equal(resolutionWithinTier('720p', access.maxResolution, RESOLUTIONS), true);
    assert.equal(resolutionWithinTier('4k', access.maxResolution, RESOLUTIONS), false);

    const remainingResponse = await budgetRoute(sql)(new Request('http://local/api/budgets/me?projectId=15&modelId=seedance-2.0'));
    assert.equal(remainingResponse.status, 200);
    const remaining = (await remainingResponse.json()).budget;
    assert.equal(remaining.limit, 250);
    assert.equal(remaining.used, 30);
    assert.equal(remaining.remaining, 220);

    await sql`INSERT INTO events (project_id, user_id, type, payload) VALUES (15, NULL, 'project.resumed', '{}'::jsonb)`;
    const adminEvents = await visibleEvents(sql, { cursor: 0, isAdmin: true, projectIds: [], userId: admin.userId });
    const requesterEvents = await visibleEvents(sql, { cursor: 0, isAdmin: false, projectIds: [15], userId: requester.userId });
    const teammateEvents = await visibleEvents(sql, { cursor: 0, isAdmin: false, projectIds: [15], userId: teammate.userId });
    const expectedVisible = ['access.granted', 'budget.request.approved', 'budget.requested', 'project.resumed'];
    assert.deepEqual(adminEvents.map((event) => event.type).sort(), expectedVisible);
    assert.deepEqual(requesterEvents.map((event) => event.type).sort(), expectedVisible);
    assert.deepEqual(teammateEvents.map((event) => event.type), ['project.resumed']);
});

test('request notification failure rolls back the request ledger row', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    await sql.query(`ALTER TABLE events ADD CONSTRAINT reject_request_event CHECK (type <> 'budget.requested')`);

    const response = await userRoutes(sql).POST(jsonRequest('http://local/api/budget-requests', {
        projectId: 15, modelId: 'seedance-2.0', quality: '1080p', increaseAmount: 50,
    }));
    assert.equal(response.status, 503);
    const [auditCount] = await sql`SELECT count(*)::int AS count FROM audit_log`;
    assert.equal(auditCount.count, 0);
});

test('approval notification failure rolls back quota, access, and decision together', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    const request = await userRoutes(sql).POST(jsonRequest('http://local/api/budget-requests', {
        projectId: 15, modelId: 'seedance-2.0', quality: '1080p', increaseAmount: 50,
    }));
    assert.equal(request.status, 201, await request.clone().text());
    const { id } = await request.json();
    await sql.query(`ALTER TABLE events ADD CONSTRAINT reject_approval_event CHECK (type <> 'budget.request.approved')`);

    const response = await decisionRoute(sql)(jsonRequest('http://local/approve', { policy: 'hard' }), {
        params: Promise.resolve({ id, action: 'approve' }),
    });
    assert.equal(response.status, 500);

    const [quota] = await sql`SELECT hard_limit FROM quotas WHERE project_id = 15 AND user_id = ${requester.userId} AND model_id = 'seedance-2.0'`;
    const [overrideCount] = await sql`SELECT count(*)::int AS count FROM user_model_overrides`;
    const [decisionCount] = await sql`SELECT count(*)::int AS count FROM audit_log WHERE action = 'budget_request.approved'`;
    assert.equal(Number(quota.hard_limit), 100);
    assert.equal(overrideCount.count, 0);
    assert.equal(decisionCount.count, 0);
});

test('denial notification failure rolls back the denial decision', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    const request = await userRoutes(sql).POST(jsonRequest('http://local/api/budget-requests', {
        projectId: 15, modelId: 'seedance-2.0', quality: '1080p', increaseAmount: 50,
    }));
    assert.equal(request.status, 201, await request.clone().text());
    const { id } = await request.json();
    await sql.query(`ALTER TABLE events ADD CONSTRAINT reject_denial_event CHECK (type <> 'budget.request.denied')`);

    const response = await decisionRoute(sql)(jsonRequest('http://local/deny', { reason: 'Not this cycle' }), {
        params: Promise.resolve({ id, action: 'deny' }),
    });
    assert.equal(response.status, 500);
    const [decisionCount] = await sql`SELECT count(*)::int AS count FROM audit_log WHERE action = 'budget_request.denied'`;
    assert.equal(decisionCount.count, 0);
});

test('all-model approval rejects a newly active model without a quality ladder and rolls back everything', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    const request = await userRoutes(sql).POST(jsonRequest('http://local/api/budget-requests', {
        projectId: 15, modelId: '*', quality: 'high', increaseAmount: 50,
    }));
    assert.equal(request.status, 201, await request.clone().text());
    const { id } = await request.json();

    await sql`INSERT INTO models (id, display_name, category, active)
        VALUES ('future-unconfigured-model', 'Future Model', 'video', true)`;
    const [beforeEvents] = await sql`SELECT count(*)::int AS count FROM events`;
    const response = await decisionRoute(sql)(jsonRequest('http://local/approve', { policy: 'hard' }), {
        params: Promise.resolve({ id, action: 'approve' }),
    });
    assert.equal(response.status, 409);

    const [quota] = await sql`SELECT hard_limit FROM quotas WHERE project_id = 15 AND user_id = ${requester.userId}`;
    const [overrideCount] = await sql`SELECT count(*)::int AS count FROM user_model_overrides`;
    const [decisionCount] = await sql`SELECT count(*)::int AS count FROM audit_log WHERE action = 'budget_request.approved'`;
    const [afterEvents] = await sql`SELECT count(*)::int AS count FROM events`;
    assert.equal(Number(quota.hard_limit), 100);
    assert.equal(overrideCount.count, 0);
    assert.equal(decisionCount.count, 0);
    assert.equal(afterEvents.count, beforeEvents.count);
});

test('approval rejects a requester removed from the project and commits no decision or grant', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    const request = await userRoutes(sql).POST(jsonRequest('http://local/api/budget-requests', {
        projectId: 15, modelId: 'seedance-2.0', quality: '1080p', increaseAmount: 50,
    }));
    assert.equal(request.status, 201, await request.clone().text());
    const { id } = await request.json();
    await sql`DELETE FROM project_memberships WHERE project_id = 15 AND user_id = ${requester.userId}`;

    const response = await decisionRoute(sql)(jsonRequest('http://local/approve', { policy: 'hard' }), {
        params: Promise.resolve({ id, action: 'approve' }),
    });
    assert.equal(response.status, 409);
    const [quota] = await sql`SELECT hard_limit FROM quotas WHERE project_id = 15 AND user_id = ${requester.userId}`;
    const [overrideCount] = await sql`SELECT count(*)::int AS count FROM user_model_overrides`;
    const [decisionCount] = await sql`SELECT count(*)::int AS count FROM audit_log WHERE action = 'budget_request.approved'`;
    assert.equal(Number(quota.hard_limit), 100);
    assert.equal(overrideCount.count, 0);
    assert.equal(decisionCount.count, 0);
});

test('request snapshots preserve a real zero cap instead of treating it as no personal limit', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    await sql`UPDATE quotas SET hard_limit = 0 WHERE project_id = 15 AND user_id = ${requester.userId}`;
    const response = await userRoutes(sql).POST(jsonRequest('http://local/api/budget-requests', {
        projectId: 15, modelId: 'seedance-2.0', quality: '1080p', increaseAmount: 25,
    }));
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal((await response.json()).request.currentLimit, 0);
});

test('authoritative reservations recheck live usage and serialize against applicable quota rows', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    const event = (generationId, amount) => ({
        generationId, projectId: 15, userId: requester.userId, modelId: 'seedance-2.0',
        modelVersionId: 'seedance-v2', units: { video_seconds: 5 },
        estCostUsd: amount, pricingSnapshot: { basis: 'estimate' },
    });

    const first = await reserveBillingEvent(sql, event('reservation-first', 60));
    const second = await reserveBillingEvent(sql, event('reservation-second', 20));
    assert.ok(first);
    assert.equal(second, null);
    const reservations = await sql`SELECT generation_id FROM billing_events WHERE event_type = 'reservation' ORDER BY id`;
    assert.deepEqual(reservations.map((row) => row.generation_id), ['reservation-first']);
});

test('cap correction and its audit are atomic against the latest reservation total', async (t) => {
    const { db, sql } = await integrationDb();
    t.after(() => db.close());
    const [before] = await sql`SELECT * FROM quotas WHERE project_id = 15 AND user_id = ${requester.userId}`;
    const reservation = await reserveBillingEvent(sql, {
        generationId: 'cap-race-reservation', projectId: 15, userId: requester.userId,
        modelId: 'seedance-2.0', modelVersionId: 'seedance-v2',
        units: { video_seconds: 5 }, estCostUsd: 60, pricingSnapshot: { basis: 'estimate' },
    });
    assert.ok(reservation);

    const rejected = await changeQuotaCapSafely(sql, {
        id: before.id, newHardLimit: 80, expectedHardLimit: 100, before,
        actor: admin, reason: 'Correct allocation',
    });
    assert.equal(rejected, null);
    let [quota] = await sql`SELECT hard_limit FROM quotas WHERE id = ${before.id}`;
    let [audits] = await sql`SELECT count(*)::int AS count FROM audit_log WHERE action = 'quota.cap_changed'`;
    assert.equal(Number(quota.hard_limit), 100);
    assert.equal(audits.count, 0);

    const accepted = await changeQuotaCapSafely(sql, {
        id: before.id, newHardLimit: 90, expectedHardLimit: 100, before,
        actor: admin, reason: 'Correct allocation',
    });
    assert.equal(Number(accepted.hard_limit), 90);
    assert.equal(Number(accepted.used), 30);
    assert.equal(Number(accepted.reserved), 60);
    [quota] = await sql`SELECT hard_limit FROM quotas WHERE id = ${before.id}`;
    [audits] = await sql`SELECT count(*)::int AS count FROM audit_log WHERE action = 'quota.cap_changed'`;
    assert.equal(Number(quota.hard_limit), 90);
    assert.equal(audits.count, 1);
});

test('approved-limit arithmetic never overwrites a newer cap', () => {
    assert.equal(nextApprovedLimit({ liveLimit: 200, minimumSafeCap: 30, increaseAmount: 50 }), 250);
    assert.equal(nextApprovedLimit({ liveLimit: 10, minimumSafeCap: 30, increaseAmount: 5 }), 35);
});
