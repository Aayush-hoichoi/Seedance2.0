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
// openai maps to its OWN env name, not OPENAI_API_KEY: that one belongs to the
// prompt enhancer, and the owner runs image generation on a separate key.
const ENV_KEYS = { byteplus: 'ARK_API_KEY', google: 'GOOGLE_API_KEY', kie: 'KIE_API_KEY', openai: 'OPENAI_IMAGE_API_KEY' };

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
        (project_id, user_id, model_id, model_version_id, priority, status, request_body)
        VALUES (${j.projectId}, ${j.userId}, ${j.modelId}, ${j.modelVersionId}, ${j.priority || 'interactive'}, ${j.status || 'queued'}, ${JSON.stringify(j.requestBody)})
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

// Reservations are the authoritative quota-enforcement boundary. Applicable
// quota rows are locked first, then usage is re-read in the next statement's
// fresh READ COMMITTED snapshot. Concurrent reservations and admin cap changes
// therefore serialize on the same rows instead of both acting on stale usage.
export async function reserveBillingEvent(sql, e) {
    const images = Number(e.units?.images || 0);
    const videoSeconds = Number(e.units?.video_seconds || 0);
    const estimatedUsd = Number(e.estCostUsd || 0);
    const [, rows] = await sql.transaction([
        sql`SELECT id FROM quotas
            WHERE deleted_at IS NULL
              AND (project_id IS NULL OR project_id = ${e.projectId})
              AND (user_id IS NULL OR user_id = ${e.userId})
              AND (model_id IS NULL OR model_id = ${e.modelId})
            ORDER BY id FOR UPDATE`,
        sql`WITH applicable AS (
                SELECT q.id, q.project_id, q.user_id, q.model_id, q.type, q."window",
                    COALESCE((
                        SELECT SUM(CASE q.type
                            WHEN 'image_count' THEN COALESCE((b.units->>'images')::numeric, 0)
                            WHEN 'video_seconds' THEN COALESCE((b.units->>'video_seconds')::numeric, 0)
                            WHEN 'request_count' THEN 1
                            ELSE COALESCE(b.cost_usd, b.est_cost_usd, 0)
                        END)
                        FROM billing_events b
                        WHERE b.created_at >= CASE q."window"
                            WHEN 'daily' THEN date_trunc('day', now())
                            WHEN 'monthly' THEN date_trunc('month', now())
                            ELSE 'epoch'::timestamptz
                        END
                          AND (q.project_id IS NULL OR b.project_id = q.project_id)
                          AND (q.user_id IS NULL OR b.user_id = q.user_id)
                          AND (q.model_id IS NULL OR b.model_id = q.model_id)
                          AND (b.event_type IN ('settlement', 'failure') OR (
                              b.event_type = 'reservation' AND NOT EXISTS (
                                  SELECT 1 FROM billing_events done
                                  WHERE done.generation_id = b.generation_id
                                    AND done.event_type IN ('settlement', 'failure', 'release')
                              )
                          ))
                    ), 0) + CASE q.type
                        WHEN 'image_count' THEN ${images}::numeric
                        WHEN 'video_seconds' THEN ${videoSeconds}::numeric
                        WHEN 'request_count' THEN 1::numeric
                        ELSE ${estimatedUsd}::numeric
                    END > q.hard_limit * CASE
                        WHEN q.policy = 'soft' THEN 1 + COALESCE(q.soft_overage_pct, 5)::numeric / 100
                        ELSE 1
                    END AS over
                FROM quotas q
                WHERE q.deleted_at IS NULL
                  AND (q.project_id IS NULL OR q.project_id = ${e.projectId})
                  AND (q.user_id IS NULL OR q.user_id = ${e.userId})
                  AND (q.model_id IS NULL OR q.model_id = ${e.modelId})
                  AND (CASE q.type
                      WHEN 'image_count' THEN ${images}::numeric
                      WHEN 'video_seconds' THEN ${videoSeconds}::numeric
                      WHEN 'request_count' THEN 1::numeric
                      ELSE ${estimatedUsd}::numeric
                  END) > 0
            )
            INSERT INTO billing_events
            (event_type, generation_id, project_id, user_id, model_id, model_version_id,
             provider_id, api_key_id, units, est_cost_usd, cost_usd, pricing_snapshot)
            SELECT 'reservation', ${e.generationId}, ${e.projectId}, ${e.userId}, ${e.modelId},
                   ${e.modelVersionId ?? null}, ${e.providerId ?? null}, ${e.apiKeyId ?? null},
                   ${e.units == null ? null : JSON.stringify(e.units)}, ${e.estCostUsd ?? null}, NULL,
                   ${e.pricingSnapshot == null ? null : JSON.stringify(e.pricingSnapshot)}
            WHERE NOT EXISTS (
                -- Mirrors evaluateQuotas' wallet-group rule (quota.mjs): inside a
                -- project, a shared per-model pool (user_id null) and the member
                -- budgets layered on it forgive each other — an over-cap wallet only
                -- blocks when the other SIDE of its group (same project/type/window)
                -- is exhausted too. Workspace-wide quotas (project_id null) never
                -- group and always bind.
                SELECT 1 FROM applicable v
                WHERE v.over
                  AND (
                      -- The project's OVERALL cap (everyone, every model) is the
                      -- total cumulative budget for the project, so it is never
                      -- forgiven by a member wallet that still has room — that
                      -- spend lands under the cap anyway. Mirrors
                      -- isProjectOverallCap in quota.mjs; without this the JS
                      -- pre-check and this atomic check disagree, and two
                      -- simultaneous requests could slip past the cap.
                      (v.project_id IS NOT NULL AND v.user_id IS NULL AND v.model_id IS NULL)
                      OR NOT EXISTS (
                          SELECT 1 FROM applicable f
                          WHERE NOT f.over
                            AND v.project_id IS NOT NULL
                            AND f.project_id = v.project_id
                            AND f.type = v.type AND f."window" = v."window"
                            AND (f.user_id IS NULL) <> (v.user_id IS NULL)
                            -- The overall cap never forgives either: headroom
                            -- under it is not headroom for a drained wallet.
                            AND NOT (f.user_id IS NULL AND f.model_id IS NULL)
                      )
                  )
            )
            RETURNING id`,
    ]);
    return rows?.[0] || null;
}

// Atomically lower/correct a cap against the latest committed usage. This uses
// the same quota-row lock as reserveBillingEvent, and writes the mandatory audit
// record in the same transaction as the cap change.
export async function changeQuotaCapSafely(sql, {
    id, newHardLimit, expectedHardLimit, before, actor, reason = null, ip = null,
    newPolicy = before?.policy ?? 'hard', newSoftOveragePct = Number(before?.soft_overage_pct ?? 5),
}) {
    const [, updatedRows] = await sql.transaction([
        sql`SELECT id FROM quotas WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`,
        sql`WITH live_usage AS (
                SELECT q.id,
                       COALESCE(SUM(CASE WHEN b.event_type IN ('settlement', 'failure') THEN
                           CASE q.type
                               WHEN 'image_count' THEN COALESCE((b.units->>'images')::numeric, 0)
                               WHEN 'video_seconds' THEN COALESCE((b.units->>'video_seconds')::numeric, 0)
                               WHEN 'request_count' THEN 1
                               ELSE COALESCE(b.cost_usd, b.est_cost_usd, 0)
                           END ELSE 0 END), 0)::float8 AS used,
                       COALESCE(SUM(CASE WHEN b.event_type = 'reservation' AND NOT EXISTS (
                           SELECT 1 FROM billing_events done
                           WHERE done.generation_id = b.generation_id
                             AND done.event_type IN ('settlement', 'failure', 'release')
                       ) THEN CASE q.type
                               WHEN 'image_count' THEN COALESCE((b.units->>'images')::numeric, 0)
                               WHEN 'video_seconds' THEN COALESCE((b.units->>'video_seconds')::numeric, 0)
                               WHEN 'request_count' THEN 1
                               ELSE COALESCE(b.cost_usd, b.est_cost_usd, 0)
                           END ELSE 0 END), 0)::float8 AS reserved
                FROM quotas q
                LEFT JOIN billing_events b
                  ON b.created_at >= CASE q."window"
                      WHEN 'daily' THEN date_trunc('day', now())
                      WHEN 'monthly' THEN date_trunc('month', now())
                      ELSE 'epoch'::timestamptz
                  END
                 AND (q.project_id IS NULL OR b.project_id = q.project_id)
                 AND (q.user_id IS NULL OR b.user_id = q.user_id)
                 AND (q.model_id IS NULL OR b.model_id = q.model_id)
                WHERE q.id = ${id} AND q.deleted_at IS NULL
                GROUP BY q.id
            ), updated AS (
                UPDATE quotas q SET hard_limit = ${newHardLimit},
                       policy = ${newPolicy}, soft_overage_pct = ${newSoftOveragePct}
                FROM live_usage usage
                WHERE q.id = usage.id AND q.hard_limit = ${expectedHardLimit}
                  AND ${newHardLimit} >= usage.used + usage.reserved
                RETURNING q.*, usage.used, usage.reserved
            ), audit AS (
                INSERT INTO audit_log
                    (actor_id, actor_email, action, target_type, target_id, before, after, reason, ip)
                SELECT ${actor.userId}, ${actor.email}, 'quota.cap_changed', 'quota', ${String(id)},
                       ${JSON.stringify(before)}::jsonb,
                       (to_jsonb(updated) - 'used' - 'reserved') || jsonb_build_object(
                           'usage_at_change', jsonb_build_object(
                               'used', updated.used,
                               'reserved', updated.reserved,
                               'minimum_hard_limit', updated.used + updated.reserved
                           )
                       ), ${reason}, ${ip}
                FROM updated
                RETURNING id
            )
            SELECT * FROM updated`,
    ]);
    return updatedRows?.[0] || null;
}

// Atomically change a budget's model scope. Usage is recomputed from scope at
// read time, so the only invariants to defend are (a) one active quota per
// exact scope and (b) no lost update against a concurrent rescope or a
// budget-request approval upserting the same scope. (b) is why this takes the
// same advisory locks as decideBudgetRequest — for BOTH the old and the new
// scope, in sorted order so two crossing rescopes cannot deadlock. The
// NOT EXISTS guard enforces (a) even on databases without the
// quotas_unique_active_scope index (budget requests run schema-migration-free,
// so that index is not guaranteed everywhere).
// Returns the updated row, or null when nothing matched (stale expected scope,
// deleted row, or an existing budget already occupying the target scope —
// the caller disambiguates).
export async function changeQuotaScopeSafely(sql, {
    id, newModelId, before, actor, reason = null, ip = null, usage = null,
}) {
    const scopeKey = (modelId) => `quota:${before.project_id ?? '*'}:${before.user_id ?? '*'}:${modelId ?? '*'}:${before.type}:${before.window}`;
    const [lockA, lockB] = [scopeKey(before.model_id ?? null), scopeKey(newModelId)].sort();
    const [, , , updatedRows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtext(${lockA}))`,
        sql`SELECT pg_advisory_xact_lock(hashtext(${lockB}))`,
        sql`SELECT id FROM quotas WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`,
        sql`WITH updated AS (
                UPDATE quotas q SET model_id = ${newModelId}
                WHERE q.id = ${id} AND q.deleted_at IS NULL
                  AND q.model_id IS NOT DISTINCT FROM ${before.model_id ?? null}
                  AND NOT EXISTS (SELECT 1 FROM quotas dup
                      WHERE dup.id <> q.id AND dup.deleted_at IS NULL
                        AND dup.project_id IS NOT DISTINCT FROM q.project_id
                        AND dup.user_id IS NOT DISTINCT FROM q.user_id
                        AND dup.model_id IS NOT DISTINCT FROM ${newModelId}
                        AND dup.type = q.type AND dup."window" = q."window")
                RETURNING q.*
            ), audit AS (
                INSERT INTO audit_log
                    (actor_id, actor_email, action, target_type, target_id, before, after, reason, ip)
                SELECT ${actor.userId}, ${actor.email}, 'quota.rescope', 'quota', ${String(id)},
                       ${JSON.stringify(before)}::jsonb,
                       to_jsonb(updated) || jsonb_build_object('usage_at_rescope', ${JSON.stringify(usage)}::jsonb),
                       ${reason}, ${ip}
                FROM updated
                RETURNING id
            )
            SELECT * FROM updated`,
    ]);
    return updatedRows?.[0] || null;
}

// --- project overall budget ---------------------------------------------------------------

// A project's *overall* budget is the everyone-scope, all-models, USD lifetime
// quota — the ceiling the whole project spends against. It is optional: with no
// such row the project is uncapped and spend is only tracked.
//
// Member budgets are carved out of that ceiling (a member's spend also counts
// against the everyone pool in reserveBillingEvent), so their caps must never
// sum past it. Only USD lifetime member budgets are sub-allocations — an
// image-count or video-seconds cap measures something the dollar ceiling does
// not.
export async function projectAllocation(sql, projectId, { excludeQuotaId = null } = {}) {
    const [overall] = await sql`SELECT hard_limit FROM quotas
        WHERE project_id = ${projectId} AND user_id IS NULL AND model_id IS NULL
          AND type = 'usd' AND "window" = 'lifetime' AND deleted_at IS NULL`;
    const [sum] = await sql`SELECT COALESCE(SUM(hard_limit), 0)::float8 AS total FROM quotas
        WHERE project_id = ${projectId} AND user_id IS NOT NULL
          AND type = 'usd' AND "window" = 'lifetime' AND deleted_at IS NULL
          AND (${excludeQuotaId}::int IS NULL OR id <> ${excludeQuotaId})`;
    return { overallCap: overall ? Number(overall.hard_limit) : null, allocated: Number(sum?.total ?? 0) };
}

// Guard for every path that grows a member budget. Returns null when the change
// fits under the project's overall budget, otherwise the numbers the caller
// needs to explain the refusal.
//   quotaId   the member budget being rewritten, excluded from the allotted sum
//             (null for a create or a top-up, where nextLimit is the delta)
//   nextLimit the member budget's new cap, or the amount being added
// ponytail: check-then-write, so two admins allocating in the same instant can
// both pass. Take a per-project advisory lock here if that race becomes real.
export async function overCommitsProject(sql, { projectId, userId, type, window, quotaId = null, nextLimit }) {
    if (!projectId || !userId || type !== 'usd' || window !== 'lifetime') return null;
    const { overallCap, allocated } = await projectAllocation(sql, projectId, { excludeQuotaId: quotaId });
    if (overallCap == null) return null; // no overall budget set → members are uncapped
    const available = overallCap - allocated;
    if (Number(nextLimit) <= available) return null;
    return { overallCap, allocated, requested: Number(nextLimit), available: Math.max(0, available) };
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

// The style an attached workspace workflow carries, or null when the id is
// absent, unknown, deleted, or the user has no approved workflow access
// (one admin approval unlocks ALL workflows; platform admins bypass).
// Callers fall back to the project's own style, so a stale attachment or a
// revoked grant degrades, never errors.
export async function workflowStyle(sql, id, { userId = null, isAdmin = false } = {}) {
    if (!Number(id)) return null;
    const [row] = await sql`SELECT style FROM workflows w
        WHERE w.id = ${Number(id)} AND w.deleted_at IS NULL
          AND (${isAdmin} OR EXISTS (
              SELECT 1 FROM workflow_access a
              WHERE a.user_id = ${userId} AND a.status = 'approved'))`;
    return row?.style ?? null;
}

// The user's workflow standing: 'none' | 'pending' | 'approved' | 'denied'.
export async function workflowAccessFor(sql, userId) {
    const [row] = await sql`SELECT status FROM workflow_access WHERE user_id = ${userId}`;
    return row?.status ?? 'none';
}

// The workflow the user attached (users.workflow_id), or null. The stored
// attachment is the fallback when a request carries no explicit workflow —
// that is what makes "attached" hold across devices, MCP, and the raw API.
export async function userWorkflowId(sql, userId) {
    if (!userId) return null;
    const [row] = await sql`SELECT workflow_id FROM users WHERE id = ${userId}`;
    return row?.workflow_id ?? null;
}
