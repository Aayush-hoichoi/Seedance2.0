// Database-backed queue for BytePlus EXR enhancement jobs.
// The worker is deliberately separate from the normal model-generation queue.

export const EXR_MAX_SUBMIT_ATTEMPTS = Number(process.env.BYTEPLUS_EXR_MAX_ATTEMPTS) || 3;
export const EXR_POLL_DELAY_MS = Number(process.env.BYTEPLUS_EXR_POLL_MS) || 5_000;
export const EXR_LEASE_SECONDS = Number(process.env.BYTEPLUS_EXR_LEASE_SECONDS) || 90;

export async function enqueueExrJob(sql, { userId, projectId = null, sourceUrl, requestBody }) {
    const [row] = await sql`INSERT INTO exr_jobs
        (project_id, user_id, source_url, request_body, status, run_after)
        VALUES (${projectId}, ${userId}, ${sourceUrl}, ${JSON.stringify(requestBody || {})}, 'queued', now())
        RETURNING *`;
    return row;
}

// Claim one runnable job. SKIP LOCKED lets multiple worker processes run at
// the same time without processing the same EXR task.
export async function claimNextExrJob(sql) {
    const [rows] = await sql.transaction([sql`
        WITH next_job AS (
            SELECT id
            FROM exr_jobs
            WHERE status IN ('queued', 'processing')
              AND (run_after IS NULL OR run_after <= now())
              AND (lease_until IS NULL OR lease_until < now())
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        UPDATE exr_jobs AS j
        SET status = 'processing',
            attempt = CASE WHEN j.provider_task_id IS NULL THEN j.attempt + 1 ELSE j.attempt END,
            poll_attempt = CASE WHEN j.provider_task_id IS NULL THEN j.poll_attempt ELSE j.poll_attempt + 1 END,
            lease_until = now() + make_interval(secs => ${EXR_LEASE_SECONDS}),
            started_at = COALESCE(j.started_at, now()),
            updated_at = now()
        FROM next_job
        WHERE j.id = next_job.id
        RETURNING j.*
    `]);
    return rows?.[0] || null;
}

export async function markExrSubmitted(sql, id, { providerTaskId, requestId }) {
    const [row] = await sql`UPDATE exr_jobs
        SET provider_task_id = ${providerTaskId}, provider_request_id = ${requestId || null},
            run_after = now() + make_interval(secs => 5), lease_until = NULL, updated_at = now()
        WHERE id = ${id} AND status = 'processing'
        RETURNING *`;
    return row || null;
}

export async function rescheduleExrJob(sql, id, { delayMs = EXR_POLL_DELAY_MS, error = null }) {
    const [row] = await sql`UPDATE exr_jobs
        SET status = 'processing', run_after = now() + make_interval(secs => ${Math.max(1, Math.ceil(delayMs / 1000))}),
            lease_until = NULL,
            error = ${error == null ? null : JSON.stringify(error)}, updated_at = now()
        WHERE id = ${id} AND status = 'processing'
        RETURNING *`;
    return row || null;
}

export async function finishExrJob(sql, id, { status, result = null, error = null }) {
    const [row] = await sql`UPDATE exr_jobs
        SET status = ${status}, finished_at = now(), lease_until = NULL,
            result = ${result == null ? null : JSON.stringify(result)},
            error = ${error == null ? null : JSON.stringify(error)}, updated_at = now()
        WHERE id = ${id} AND status = 'processing'
        RETURNING *`;
    return row || null;
}

export async function getExrJobForUser(sql, id, userId) {
    const [row] = await sql`SELECT * FROM exr_jobs WHERE id = ${id} AND user_id = ${userId}`;
    return row || null;
}

export async function getExrQueue(sql, { status = null, limit = 200 } = {}) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 200));
    const [items, counts] = await Promise.all([
        sql`SELECT j.*, p.name AS project_name, u.email AS user_email, u.name AS user_name
            FROM exr_jobs j
            LEFT JOIN projects p ON p.id = j.project_id
            LEFT JOIN users u ON u.id = j.user_id
            WHERE (${status}::text IS NULL OR j.status = ${status})
            ORDER BY j.created_at DESC LIMIT ${safeLimit}`,
        sql`SELECT status, count(*)::int AS count FROM exr_jobs GROUP BY status ORDER BY status`,
    ]);
    return { items, counts };
}

export async function retryExrJob(sql, id) {
    const [row] = await sql`UPDATE exr_jobs
        SET status = 'queued', attempt = 0, poll_attempt = 0, provider_task_id = NULL,
            provider_request_id = NULL, result = NULL, error = NULL,
            run_after = now(), lease_until = NULL, started_at = NULL, finished_at = NULL, updated_at = now()
        WHERE id = ${id} AND status IN ('failed', 'cancelled')
          -- Budgeted tool jobs (upscale) are not retryable: their reservation is
          -- already closed, so a retry would run unbudgeted. The user resubmits.
          AND NOT (request_body ? '_upscale')
        RETURNING *`;
    return row || null;
}

export async function rearchiveExrJob(sql, id) {
    const [row] = await sql`UPDATE exr_jobs
        SET status = 'processing', run_after = now(), lease_until = NULL, error = NULL,
            finished_at = NULL, updated_at = now()
        WHERE id = ${id}
            AND status = 'succeeded'
            AND result->>'url' IS NOT NULL
            AND coalesce((result->>'durable')::boolean, false) = false
        RETURNING *`;
    return row || null;
}

export async function cancelExrJob(sql, id) {
    const [row] = await sql`UPDATE exr_jobs
        SET status = 'cancelled', finished_at = now(), lease_until = NULL,
            error = ${JSON.stringify({ message: 'Cancelled by an administrator.' })}, updated_at = now()
        WHERE id = ${id} AND status IN ('queued', 'processing')
        RETURNING *`;
    return row || null;
}

export function publicExrStatus(row) {
    if (!row) return null;
    const status = row.status === 'queued' ? 'queued' : row.status === 'processing' ? 'processing' : row.status;
    return {
        id: row.id,
        status,
        attempt: row.attempt,
        providerTaskId: row.provider_task_id || null,
        providerRequestId: row.provider_request_id || null,
        result: row.result || null,
        error: row.error?.message || row.error || null,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
    };
}
