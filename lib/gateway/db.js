// Server-only gateway data access. Thin IO around the pure engines in
// access.mjs / quota.mjs / queueLogic.mjs — no business decisions here.

import { getDb } from '../db/neon.js';
import { decryptSecret } from './keybox.mjs';
import { windowBounds } from './quota.mjs';
import { PROJECT_CONCURRENCY, MODEL_CONCURRENCY } from './queueLogic.mjs';

export { getDb };

// --- events + audit ----------------------------------------------------------

export async function emitEvent(sql, { projectId = null, userId = null, type, payload = {} }) {
    await sql`INSERT INTO events (project_id, user_id, type, payload)
        VALUES (${projectId}, ${userId}, ${type}, ${JSON.stringify(payload)})`;
}

export async function writeAudit(sql, { actorId, actorEmail = null, action, targetType = null, targetId = null, before = null, after = null, reason = null, ip = null }) {
    await sql`INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, before, after, reason, ip)
        VALUES (${actorId}, ${actorEmail}, ${action}, ${targetType}, ${targetId == null ? null : String(targetId)},
                ${before == null ? null : JSON.stringify(before)}, ${after == null ? null : JSON.stringify(after)}, ${reason}, ${ip})`;
}

// --- catalog / routing ---------------------------------------------------------

// Model alias → current version + its provider routes in failover order.
export async function resolveRouting(sql, modelId) {
    const [model] = await sql`SELECT * FROM models WHERE id = ${modelId} AND active = true`;
    if (!model?.current_version_id) return null;
    const [version] = await sql`SELECT * FROM model_versions WHERE id = ${model.current_version_id}`;
    if (!version) return null;
    const routes = await sql`SELECT * FROM provider_routes
        WHERE model_version_id = ${version.id} AND status = 'active'
        ORDER BY priority ASC`;
    return { model, version, routes };
}

// Provider key: project-scoped → workspace-wide → env fallback. Returns
// { key, apiKeyId } — key is plaintext for the outbound call only.
const ENV_KEYS = { byteplus: 'ARK_API_KEY', google: 'GOOGLE_API_KEY' };

export async function resolveApiKey(sql, { providerId, projectId }) {
    const rows = await sql`SELECT * FROM api_keys
        WHERE provider_id = ${providerId} AND status = 'active'
          AND (scope_project_id = ${projectId} OR scope_project_id IS NULL)
        ORDER BY scope_project_id NULLS LAST, id DESC`;
    for (const row of rows) {
        const key = decryptSecret(row.ciphertext);
        if (key) return { key, apiKeyId: row.id };
    }
    const envKey = process.env[ENV_KEYS[providerId] || ''];
    return envKey ? { key: envKey, apiKeyId: null } : null;
}

// --- jobs -------------------------------------------------------------------------

export async function insertJob(sql, j) {
    const [row] = await sql`INSERT INTO jobs
        (project_id, user_id, model_id, model_version_id, priority, request_body)
        VALUES (${j.projectId}, ${j.userId}, ${j.modelId}, ${j.modelVersionId}, ${j.priority || 'interactive'}, ${JSON.stringify(j.requestBody)})
        RETURNING *`;
    return row;
}

export async function getJob(sql, id) {
    const [row] = await sql`SELECT * FROM jobs WHERE id = ${id}`;
    return row || null;
}

export async function queueState(sql) {
    const queued = await sql`SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 200`;
    const running = await sql`SELECT * FROM jobs WHERE status = 'running'`;
    const paused = await sql`SELECT id FROM projects WHERE paused = true`;
    return { queued, running, pausedProjectIds: paused.map((p) => p.id) };
}

// Atomic claim: only wins if the row is still queued AND the concurrency
// caps hold at commit time. The advisory xact-lock serializes claims across
// serverless instances so the cap subqueries cannot race (pickNextJob's
// snapshot check is advisory; THIS is the enforcement).
// ponytail: one global lock — shard by project hash if claim throughput matters.
export async function claimJob(sql, id, { timeoutAt }) {
    const [, rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtext('gateway:claim'))`,
        sql`UPDATE jobs
            SET status = 'running', started_at = now(), attempt = attempt + 1, timeout_at = ${timeoutAt}
            WHERE id = ${id} AND status = 'queued'
              AND (SELECT count(*) FROM jobs r WHERE r.project_id = jobs.project_id AND r.status = 'running') < ${PROJECT_CONCURRENCY}
              AND (SELECT count(*) FROM jobs r WHERE r.model_id = jobs.model_id AND r.status = 'running') < ${MODEL_CONCURRENCY}
            RETURNING *`,
    ]);
    return rows?.[0] || null;
}

export async function finishJob(sql, id, { status, result = null, error = null, providerId = null, providerTaskId = null }) {
    const [row] = await sql`UPDATE jobs
        SET status = ${status}, finished_at = now(),
            result = COALESCE(${result == null ? null : JSON.stringify(result)}, result),
            error = COALESCE(${error == null ? null : JSON.stringify(error)}, error),
            provider_id = COALESCE(${providerId}, provider_id),
            provider_task_id = COALESCE(${providerTaskId}, provider_task_id)
        WHERE id = ${id} AND status IN ('queued', 'running')
        RETURNING *`;
    return row || null;
}

export async function requeueJob(sql, id, { runAfterMs, error }) {
    await sql`UPDATE jobs
        SET status = 'queued', run_after = now() + make_interval(secs => ${Math.round(runAfterMs / 1000)}),
            error = ${JSON.stringify(error || null)}
        WHERE id = ${id} AND status = 'running'`;
}

export async function markSubmitted(sql, id, { providerId, providerTaskId = null, batchJobName = null, batchIndex = null }) {
    await sql`UPDATE jobs
        SET provider_id = ${providerId}, provider_task_id = ${providerTaskId},
            batch_job_name = ${batchJobName}, batch_index = ${batchIndex}
        WHERE id = ${id}`;
}

export async function queuedDepth(sql, projectId) {
    const [row] = await sql`SELECT count(*)::int AS n FROM jobs WHERE project_id = ${projectId} AND status = 'queued'`;
    return row?.n ?? 0;
}

// --- billing (append-only) -----------------------------------------------------------

export async function insertBillingEvent(sql, e) {
    await sql`INSERT INTO billing_events
        (event_type, generation_id, project_id, user_id, model_id, model_version_id,
         provider_id, api_key_id, units, est_cost_usd, cost_usd, pricing_snapshot)
        VALUES (${e.eventType}, ${e.generationId}, ${e.projectId}, ${e.userId}, ${e.modelId},
                ${e.modelVersionId ?? null}, ${e.providerId ?? null}, ${e.apiKeyId ?? null},
                ${e.units == null ? null : JSON.stringify(e.units)}, ${e.estCostUsd ?? null}, ${e.costUsd ?? null},
                ${e.pricingSnapshot == null ? null : JSON.stringify(e.pricingSnapshot)})`;
}

// --- quota usage sums --------------------------------------------------------------------

function scopeSql(quota) {
    // Null means no filter for that scope dimension.
    return [quota.project_id ?? null, quota.user_id ?? null, quota.model_id ?? null];
}

function unitExpr(type) {
    if (type === 'image_count') return `COALESCE((units->>'images')::numeric, 0)`;
    if (type === 'video_seconds') return `COALESCE((units->>'video_seconds')::numeric, 0)`;
    if (type === 'request_count') return '1';
    return `COALESCE(cost_usd, est_cost_usd, 0)`; // usd | credits
}

// Settled + open-reservation totals for each quota, in its own window.
export async function usageForQuotas(sql, quotas, now = new Date()) {
    const usedByQuota = {};
    const reservedByQuota = {};
    for (const quota of quotas) {
        const { start } = windowBounds(quota.window, now);
        const [projectId, userId, modelId] = scopeSql(quota);
        const expr = unitExpr(quota.type);
        const [used] = await sql.query(
            `SELECT COALESCE(SUM(${expr}), 0) AS total FROM billing_events
             WHERE event_type IN ('settlement', 'failure') AND created_at >= $1
               AND ($2::int IS NULL OR project_id = $2)
               AND ($3::text IS NULL OR user_id = $3)
               AND ($4::text IS NULL OR model_id = $4)`,
            [start.toISOString(), projectId, userId, modelId],
        );
        const [reserved] = await sql.query(
            `SELECT COALESCE(SUM(${expr}), 0) AS total FROM billing_events r
             WHERE r.event_type = 'reservation' AND r.created_at >= $1
               AND ($2::int IS NULL OR r.project_id = $2)
               AND ($3::text IS NULL OR r.user_id = $3)
               AND ($4::text IS NULL OR r.model_id = $4)
               AND NOT EXISTS (SELECT 1 FROM billing_events c
                    WHERE c.generation_id = r.generation_id
                      AND c.event_type IN ('settlement', 'failure', 'release'))`,
            [start.toISOString(), projectId, userId, modelId],
        );
        usedByQuota[quota.id] = Number(used?.total ?? 0);
        reservedByQuota[quota.id] = Number(reserved?.total ?? 0);
    }
    return { usedByQuota, reservedByQuota };
}

// Admin budget views can explain a quota total by model. Keep this separate
// from usageForQuotas: that function is also on the request-enforcement path,
// where the additional grouped query would add latency without changing a
// quota decision.
export async function modelUsageForQuotas(sql, quotas, now = new Date()) {
    const breakdownByQuota = {};
    for (const quota of quotas) {
        const { start } = windowBounds(quota.window, now);
        const [projectId, userId, modelId] = scopeSql(quota);
        const expr = unitExpr(quota.type);
        const rows = await sql.query(
            `SELECT x.model_id,
                    COALESCE(m.display_name, x.model_id) AS model_name,
                    COALESCE(SUM(x.used), 0)::float8 AS used,
                    COALESCE(SUM(x.reserved), 0)::float8 AS reserved
             FROM (
                SELECT b.model_id, ${expr} AS used, 0::numeric AS reserved
                FROM billing_events b
                WHERE b.event_type IN ('settlement', 'failure') AND b.created_at >= $1
                  AND ($2::int IS NULL OR b.project_id = $2)
                  AND ($3::text IS NULL OR b.user_id = $3)
                  AND ($4::text IS NULL OR b.model_id = $4)
                UNION ALL
                SELECT r.model_id, 0::numeric AS used, ${expr} AS reserved
                FROM billing_events r
                WHERE r.event_type = 'reservation' AND r.created_at >= $1
                  AND ($2::int IS NULL OR r.project_id = $2)
                  AND ($3::text IS NULL OR r.user_id = $3)
                  AND ($4::text IS NULL OR r.model_id = $4)
                  AND NOT EXISTS (SELECT 1 FROM billing_events c
                       WHERE c.generation_id = r.generation_id
                         AND c.event_type IN ('settlement', 'failure', 'release'))
             ) x
             LEFT JOIN models m ON m.id = x.model_id
             GROUP BY x.model_id, m.display_name
             ORDER BY SUM(x.used) DESC, SUM(x.reserved) DESC, model_name`,
            [start.toISOString(), projectId, userId, modelId],
        );
        breakdownByQuota[quota.id] = rows.map((row) => ({
            model_id: row.model_id,
            model_name: row.model_name,
            used: Number(row.used ?? 0),
            reserved: Number(row.reserved ?? 0),
        }));
    }
    return breakdownByQuota;
}

export async function activeQuotas(sql) {
    return sql`SELECT * FROM quotas WHERE deleted_at IS NULL`;
}
