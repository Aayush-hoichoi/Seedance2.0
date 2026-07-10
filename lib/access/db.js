// Server-only. Model-access grants/requests + usage-event persistence on Neon.
// Thin wrappers over getDb(); never import into client code.

import { getDb } from '../db/neon.js';
import { MODELS } from '../seedance/constants.js';
import { costFromTokens } from '../seedance/pricing.mjs';

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
    const rows = await sql`SELECT model_id FROM model_access_requests
        WHERE user_id = ${userId} AND status = 'approved'`;
    return rows.map((r) => r.model_id);
}

export async function getRequestsForUser(userId) {
    const sql = await getDb();
    if (!sql) return [];
    return sql`SELECT model_id, status FROM model_access_requests WHERE user_id = ${userId}`;
}

export async function requestAccess(userId, email, modelId, note) {
    const sql = await getDb();
    if (!sql) throw new Error('Access store unavailable');
    await sql`INSERT INTO model_access_requests (user_id, user_email, model_id, status, note, created_at)
        VALUES (${userId}, ${email}, ${modelId}, 'pending', ${note ?? null}, now())
        ON CONFLICT (user_id, model_id) DO UPDATE
        SET status = 'pending', note = ${note ?? null}, user_email = ${email},
            created_at = now(), decided_by = NULL, decided_at = NULL`;
}

export async function listRequests() {
    const sql = await getDb();
    if (!sql) return [];
    return sql`SELECT id, user_id, user_email, model_id, status, note, decided_by, created_at, decided_at
        FROM model_access_requests
        ORDER BY (status = 'pending') DESC, created_at DESC`;
}

export async function setRequestStatus(id, status, decidedBy) {
    const sql = await getDb();
    if (!sql) throw new Error('Access store unavailable');
    const rows = await sql`UPDATE model_access_requests
        SET status = ${status}, decided_by = ${decidedBy}, decided_at = now()
        WHERE id = ${id}
        RETURNING id, user_id, model_id, status`;
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

export async function getUsagePerUserModel() {
    const sql = await getDb();
    if (!sql) return [];
    return sql`SELECT user_id, model_id,
        count(*) FILTER (WHERE status <> 'failed') AS generations,
        coalesce(sum(coalesce(cost_usd, est_cost_usd)) FILTER (WHERE status <> 'failed'), 0) AS cost_usd
        FROM usage_events GROUP BY user_id, model_id`;
}
