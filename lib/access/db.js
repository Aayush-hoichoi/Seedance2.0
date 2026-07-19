// Server-only. Model-access grants/requests + usage-event persistence on Neon.
// Thin wrappers over getDb(); never import into client code.

import { getDb } from '../db/neon.js';
import { MODELS } from '../seedance/constants.js';
import { costFromTokens } from '../seedance/pricing.mjs';
import { reRequestDecision } from './requestStatus.mjs';

const kindOf = (modelId) => MODELS.find((m) => m.id === modelId)?.kind ?? null;

// --- Clerk-webhook sync: keep the canonical users table + denormalized emails ---

export async function upsertUser({ id, email, name, role, createdAtMs }) {
    const sql = await getDb();
    if (!sql) return;
    await sql`INSERT INTO users (id, email, name, role, created_at, updated_at)
        VALUES (${id}, ${email ?? null}, ${name ?? null}, ${role ?? null},
                COALESCE(to_timestamp(${createdAtMs ?? null}::double precision / 1000.0), now()), now())
        ON CONFLICT (id) DO UPDATE
            SET email = EXCLUDED.email, name = EXCLUDED.name, role = EXCLUDED.role,
                updated_at = now(), deleted_at = NULL`;
    // Keep the denormalized email in the child tables consistent with Clerk.
    if (email) {
        await sql`UPDATE model_access_requests SET user_email = ${email} WHERE user_id = ${id}`;
        await sql`UPDATE usage_events SET user_email = ${email} WHERE user_id = ${id}`;
    }
}

// Immediate role sync after an admin action — the Clerk webhook (user.updated)
// writes the same value moments later; doing it here too keeps the admin UI's
// refetch from racing the webhook.
export async function setUserRole(id, role) {
    const sql = await getDb();
    if (!sql) return;
    await sql`UPDATE users SET role = ${role ?? null}, updated_at = now() WHERE id = ${id}`;
}

export async function deleteUserData(id) {
    const sql = await getDb();
    if (!sql) return;
    // Soft-delete identity (retain usage_events for accounting); void access grants.
    await sql`UPDATE users SET deleted_at = now(), updated_at = now() WHERE id = ${id}`;
    await sql`DELETE FROM model_access_requests WHERE user_id = ${id}`;
}

export async function getApprovedModelIds(userId) {
    const sql = await getDb();
    if (!sql) return [];
    // A time-boxed approval stops unlocking the model once expires_at passes.
    const rows = await sql`SELECT model_id FROM model_access_requests
        WHERE user_id = ${userId} AND status = 'approved'
          AND (expires_at IS NULL OR expires_at > now())`;
    return rows.map((r) => r.model_id);
}

export async function getRequestsForUser(userId) {
    const sql = await getDb();
    if (!sql) return [];
    return sql`SELECT model_id, status, expires_at, project_id, max_resolution, pending_max_resolution
        FROM model_access_requests WHERE user_id = ${userId}`;
}

// Current-calendar-month spend for one user — same math as the console
// rollups (usageQuery.js): settlement/failure events, real cost when
// settled, the estimate otherwise. Null when the DB isn't configured.
export async function getMonthSpendUsd(userId) {
    const sql = await getDb();
    if (!sql) return null;
    const [row] = await sql`SELECT COALESCE(SUM(COALESCE(cost_usd, est_cost_usd, 0)), 0)::float8 AS usd
        FROM billing_events
        WHERE user_id = ${userId}
          AND event_type IN ('settlement', 'failure')
          AND created_at >= date_trunc('month', now())`;
    return row?.usd ?? 0;
}

export async function requestAccess(userId, email, modelId, note, projectId, maxResolution = null, ladder = null) {
    const sql = await getDb();
    if (!sql) throw new Error('Access store unavailable');
    // Per (user, model, project): the same model can be requested for more than
    // one project. Decide off the existing row (reRequestDecision): a live
    // pending request is returned as-is so callers don't re-ping Slack, a live
    // grant is never downgraded by a stray click, and an approved-but-EXPIRED
    // grant re-opens as a fresh request. A live grant asked for a HIGHER tier
    // becomes an upgrade: the wanted tier parks in pending_max_resolution and
    // the grant stays live (nothing re-locks). `fresh` tells callers to notify.
    const [existing] = await sql`SELECT id, status, expires_at, max_resolution, pending_max_resolution
        FROM model_access_requests
        WHERE user_id = ${userId} AND model_id = ${modelId} AND project_id = ${projectId} LIMIT 1`;
    const decision = reRequestDecision(existing, new Date(), maxResolution, ladder);
    if (decision === 'pending' || decision === 'approved' || decision === 'covered') {
        return { id: existing.id, status: decision, fresh: false };
    }
    if (decision === 'upgrade') {
        // Guard re-checks the invariant under concurrency (a revoke racing this
        // ask): parking an upgrade only lands on a still-approved row; a miss
        // falls through to the fresh-request upsert below.
        const rows = await sql`UPDATE model_access_requests
            SET pending_max_resolution = ${maxResolution}, note = ${note ?? null}, user_email = ${email}
            WHERE id = ${existing.id} AND status = 'approved'
            RETURNING id, max_resolution`;
        if (rows[0]) return { id: rows[0].id, status: 'upgrade_pending', fresh: true, currentMax: rows[0].max_resolution ?? null };
    }
    if (decision === 'pending_bump') {
        // Still-undecided ask at a different tier: last ask wins, and the fresh
        // ping shows the admin the new tier. A miss (it got decided under us)
        // falls through to the fresh-request upsert.
        const rows = await sql`UPDATE model_access_requests
            SET max_resolution = ${maxResolution}, note = ${note ?? null}, user_email = ${email}, created_at = now()
            WHERE id = ${existing.id} AND status = 'pending'
            RETURNING id`;
        if (rows[0]) return { id: rows[0].id, status: 'pending', fresh: true };
    }
    // The WHERE guard re-checks the no-downgrade invariant under concurrency: a
    // grant approved between the SELECT above and this upsert survives untouched.
    const rows = await sql`INSERT INTO model_access_requests (user_id, user_email, model_id, project_id, status, note, max_resolution, pending_max_resolution, created_at)
        VALUES (${userId}, ${email}, ${modelId}, ${projectId}, 'pending', ${note ?? null}, ${maxResolution ?? null}, NULL, now())
        ON CONFLICT (user_id, model_id, project_id) DO UPDATE
        SET status = 'pending', note = ${note ?? null}, user_email = ${email}, max_resolution = ${maxResolution ?? null},
            pending_max_resolution = NULL,
            created_at = now(), decided_by = NULL, decided_at = NULL, expires_at = NULL
        WHERE model_access_requests.status <> 'approved'
           OR (model_access_requests.expires_at IS NOT NULL AND model_access_requests.expires_at <= now())
        RETURNING id, status`;
    if (!rows[0]) return { id: existing?.id ?? null, status: 'approved', fresh: false };
    return { id: rows[0].id, status: 'pending', fresh: true };
}

export async function listRequests() {
    const sql = await getDb();
    if (!sql) return [];
    return sql`SELECT r.id, r.user_id, r.user_email, r.model_id, r.status, r.note, r.max_resolution, r.pending_max_resolution,
            r.decided_by, r.created_at, r.decided_at, r.expires_at, r.project_id, p.name AS project_name
        FROM model_access_requests r
        LEFT JOIN projects p ON p.id = r.project_id
        ORDER BY (r.status = 'pending') DESC, r.created_at DESC`;
}

// Live model-access grants only: approved and not past expiry (mirrors the
// getApprovedModelIds filter). Powers the /all-access Slack command.
export async function listActiveGrants() {
    const sql = await getDb();
    if (!sql) return [];
    return sql`SELECT r.id, r.user_id, r.user_email, r.model_id, r.decided_by,
            r.expires_at, r.project_id, r.max_resolution, p.name AS project_name
        FROM model_access_requests r
        LEFT JOIN projects p ON p.id = r.project_id
        WHERE r.status = 'approved' AND (r.expires_at IS NULL OR r.expires_at > now())
        ORDER BY r.expires_at IS NULL DESC, r.expires_at ASC, r.decided_at DESC`;
}

// expiresAt (ISO string or null) time-boxes an approval; it's cleared on revoke.
// maxResolution is the ADMIN's granted quality tier — it may be lower than what
// the user requested; null falls back to the pending upgrade ask (if any), then
// to whatever the request originally asked for.
export async function setRequestStatus(id, status, decidedBy, expiresAt = null, maxResolution = null) {
    const sql = await getDb();
    if (!sql) throw new Error('Access store unavailable');
    // Approve lands on a pending request OR an approved row with a pending tier
    // upgrade — a stale duplicate Slack card must not re-approve a decided one
    // (the upgrade guard self-clears: the first approve NULLs the pending tier,
    // so a second click misses). Approving re-times the grant (fresh expiry).
    // Revoke stays unconditional: it legitimately targets an approved grant —
    // and clears any parked upgrade ask with it.
    const rows = await sql`UPDATE model_access_requests
        SET status = ${status}, decided_by = ${decidedBy}, decided_at = now(),
            expires_at = ${status === 'approved' ? expiresAt : null},
            max_resolution = COALESCE(${maxResolution ?? null}, model_access_requests.pending_max_resolution, model_access_requests.max_resolution),
            pending_max_resolution = NULL
        WHERE id = ${id} AND (${status} <> 'approved'
            OR model_access_requests.status = 'pending'
            OR model_access_requests.pending_max_resolution IS NOT NULL)
        RETURNING id, user_id, user_email, model_id, status, expires_at, project_id, max_resolution`;
    return rows[0] ?? null;
}

// Decline ONLY a parked tier-upgrade ask: the pending tier is cleared and the
// live grant (and its expiry) stays exactly as it was. Returns null when there
// is no live upgrade to decline (already decided, or a plain pending request —
// those are declined via setRequestStatus/'revoked' as before).
export async function denyUpgrade(id, decidedBy) {
    const sql = await getDb();
    if (!sql) throw new Error('Access store unavailable');
    const rows = await sql`UPDATE model_access_requests
        SET pending_max_resolution = NULL, decided_by = ${decidedBy}, decided_at = now()
        WHERE id = ${id} AND status = 'approved' AND pending_max_resolution IS NOT NULL
        RETURNING id, user_id, user_email, model_id, status, expires_at, project_id, max_resolution`;
    return rows[0] ?? null;
}

export async function logUsage(e) {
    const sql = await getDb();
    if (!sql) return;
    try {
        await sql`INSERT INTO usage_events
            (user_id, user_email, model_id, resolution, duration, ratio, mode, has_video_input, task_id, status, est_cost_usd, created_at)
            VALUES (${e.userId}, ${e.email}, ${e.modelId}, ${e.resolution ?? null}, ${e.duration ?? null},
                    ${e.ratio ?? null}, ${e.mode ?? null}, ${e.hasVideoInput ?? false}, ${e.taskId ?? null},
                    'created', ${e.estCostUsd ?? null}, now())
            ON CONFLICT (task_id) DO NOTHING`;
    } catch (err) {
        console.error('[usage] log failed:', err.message); // best-effort; never blocks a generation
    }
}

// Finalize a usage row from the terminal task state. Reads the stored row so
// cost uses the resolution/video-input captured at creation. Idempotent and
// scoped to the owning user. Returns { taskId, status, costUsd } or null.
export async function finalizeUsage(taskId, userId, { status, completionTokens }) {
    const sql = await getDb();
    if (!sql) return null;
    const rows = await sql`SELECT model_id, resolution, has_video_input
        FROM usage_events WHERE task_id = ${taskId} AND user_id = ${userId}`;
    const row = rows[0];
    if (!row) return null;
    let costUsd = 0;
    if (status === 'succeeded') {
        const kind = kindOf(row.model_id);
        costUsd = kind && completionTokens != null && row.resolution
            ? costFromTokens(kind, row.resolution, row.has_video_input, completionTokens)
            : null;
    }
    await sql`UPDATE usage_events
        SET status = ${status}, completion_tokens = ${completionTokens ?? null},
            cost_usd = ${costUsd}, finalized_at = now()
        WHERE task_id = ${taskId} AND user_id = ${userId}`;
    return { taskId, status, costUsd };
}

// Admin aggregates. All-time (v1). Failed rows excluded from cost; est_cost_usd
// is the fallback when the actual cost was never finalized.
export async function getUsagePerUser() {
    const sql = await getDb();
    if (!sql) return [];
    return sql`SELECT user_id, user_email,
        count(*) FILTER (WHERE status <> 'failed') AS generations,
        coalesce(sum(coalesce(cost_usd, est_cost_usd)) FILTER (WHERE status <> 'failed'), 0) AS cost_usd
        FROM usage_events GROUP BY user_id, user_email ORDER BY cost_usd DESC`;
}

// --- Community gallery: creators, their generations, and task ownership ---

// Who created a task (from the jobs-backed gallery_generations view). null =
// unknown owner — a task from before per-user tracking existed.
export async function getTaskOwner(taskId) {
    const sql = await getDb();
    if (!sql || !taskId) return null;
    const rows = await sql`SELECT user_id FROM gallery_generations WHERE task_id = ${taskId}`;
    return rows[0]?.user_id ?? null;
}

// Every creator for the gallery: all live Clerk users (even with 0 videos)
// plus any usage-only identity from before the users table existed.
export async function listCreators() {
    const sql = await getDb();
    if (!sql) return [];
    return sql`SELECT coalesce(u.id, s.user_id) AS id,
            coalesce(u.name, split_part(coalesce(u.email, s.user_email), '@', 1)) AS name,
            coalesce(u.email, s.user_email) AS email,
            u.role,
            coalesce(s.generations, 0)::int AS generations,
            s.last_at
        FROM users u
        FULL OUTER JOIN (
            SELECT user_id, max(user_email) AS user_email,
                count(*) FILTER (WHERE status <> 'failed') AS generations,
                max(created_at) AS last_at
            FROM gallery_generations GROUP BY user_id
        ) s ON s.user_id = u.id
        WHERE u.deleted_at IS NULL OR u.id IS NULL
        ORDER BY s.last_at DESC NULLS LAST, u.created_at DESC`;
}

// One creator's generations, newest first, joined with the prompt store so the
// gallery can show + reuse the prompt/refs. Binned (soft-deleted) and failed
// generations stay out of the gallery.
export async function listUserGenerations(userId, limit = 200) {
    const sql = await getDb();
    if (!sql) return [];
    return sql`SELECT e.task_id, e.model_id, e.resolution, e.duration, e.ratio, e.mode,
            e.status, e.created_at, e.category, e.image_key, e.image_prompt,
            p.user_prompt, p.generated_prompt, p.style, p.refs, p.liked, p.project_id
        FROM gallery_generations e
        LEFT JOIN seedance_prompts p ON p.task_id = e.task_id
        WHERE e.user_id = ${userId} AND e.task_id IS NOT NULL
            AND e.status <> 'failed' AND coalesce(p.deleted, false) = false
        ORDER BY e.created_at DESC
        LIMIT ${limit}`;
}

// Every liked generation across the platform (likes are a shared mark on the
// task), newest first, with the creator resolved for display. Legacy tasks
// without a usage row still appear — their creator/settings are just unknown.
export async function listLikedGenerations(limit = 200) {
    const sql = await getDb();
    if (!sql) return [];
    return sql`SELECT p.task_id, p.user_prompt, p.generated_prompt, p.style, p.refs, p.liked,
            e.model_id, e.resolution, e.duration, e.ratio, e.mode, e.status, e.user_id,
            coalesce(e.created_at, p.created_at) AS created_at,
            coalesce(u.name, split_part(coalesce(u.email, e.user_email), '@', 1)) AS creator_name,
            coalesce(u.email, e.user_email) AS creator_email
        FROM seedance_prompts p
        LEFT JOIN gallery_generations e ON e.task_id = p.task_id
        LEFT JOIN users u ON u.id = e.user_id
        WHERE p.liked = true AND p.deleted = false AND coalesce(e.status, '') <> 'failed'
        ORDER BY coalesce(e.created_at, p.created_at) DESC
        LIMIT ${limit}`;
}

export async function getUsagePerUserModel() {
    const sql = await getDb();
    if (!sql) return [];
    return sql`SELECT user_id, model_id,
        count(*) FILTER (WHERE status <> 'failed') AS generations,
        coalesce(sum(coalesce(cost_usd, est_cost_usd)) FILTER (WHERE status <> 'failed'), 0) AS cost_usd
        FROM usage_events GROUP BY user_id, model_id`;
}
