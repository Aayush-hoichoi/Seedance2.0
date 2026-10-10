// Gallery reads kept separate from the connection wrapper so the SQL can be
// exercised against a real Postgres in tests. `gallery_generations.project_id`
// is canonical for both image and video jobs; seedance_prompts has no row for
// images and therefore must never be used as the source of project ownership.

// Keep SQL ordering on a whitelist: both gallery and console use this roster.
const CREATOR_ORDERINGS = {
    volume: 'coalesce(s.generations, 0) DESC, s.last_at DESC NULLS LAST, u.created_at DESC',
    recent: 's.last_at DESC NULLS LAST, coalesce(s.generations, 0) DESC, u.created_at DESC',
};

export function creatorOrderBy(order) {
    return CREATOR_ORDERINGS[order] || CREATOR_ORDERINGS.volume;
}

export async function queryCreators(sql, { order = 'volume' } = {}) {
    return sql.query(`WITH orphan_jobs AS MATERIALIZED (
            -- Only identities absent from Clerk need a historical zero-count
            -- row. Materialize the anti-join before testing JSON visibility so
            -- this fallback never decodes every known user's request payload.
            SELECT j.user_id, j.provider_task_id, j.request_body, j.result
            FROM jobs j
            WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = j.user_id)
        ), activity AS (
            SELECT j.user_id, NULL::text AS user_email, count(*) AS generations,
                max(coalesce(j.started_at, j.created_at)) AS last_at
            FROM jobs j
            -- Matches jobs_gallery_creator_summary's partial predicate. The
            -- index supplies the complete aggregate without loading JSON that
            -- can contain megabytes of inline reference images per generation.
            WHERE j.status <> 'failed'
                AND coalesce(j.request_body->'options'->>'mode', '') <> 'tryon'
                AND (j.provider_task_id IS NOT NULL
                    OR (coalesce(j.request_body->>'category', 'video') = 'image'
                        AND (j.result->'images'->0->>'key' IS NOT NULL
                            OR j.result->'images'->0->>'url' IS NOT NULL)))
            GROUP BY j.user_id
            UNION ALL
            SELECT j.user_id, NULL::text, 0::bigint, NULL::timestamptz
            FROM orphan_jobs j
            WHERE j.provider_task_id IS NOT NULL
                OR (coalesce(j.request_body->>'category', 'video') = 'image'
                    AND (j.result->'images'->0->>'key' IS NOT NULL
                        OR j.result->'images'->0->>'url' IS NOT NULL))
            GROUP BY j.user_id
            UNION ALL
            SELECT ue.user_id, max(ue.user_email),
                count(*) FILTER (WHERE ue.status <> 'failed' AND coalesce(ue.mode, '') <> 'tryon'),
                max(ue.created_at) FILTER (WHERE ue.status <> 'failed' AND coalesce(ue.mode, '') <> 'tryon')
            FROM usage_events ue
            WHERE ue.task_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.provider_task_id = ue.task_id)
            GROUP BY ue.user_id
        ), summary AS (
            SELECT user_id, max(user_email) AS user_email,
                sum(generations) AS generations, max(last_at) AS last_at
            FROM activity GROUP BY user_id
        )
        SELECT coalesce(u.id, s.user_id) AS id,
            coalesce(u.name, split_part(coalesce(u.email, s.user_email), '@', 1)) AS name,
            coalesce(u.email, s.user_email) AS email,
            u.role, coalesce(u.generation_paused, false) AS generation_paused,
            coalesce(s.generations, 0)::int AS generations, s.last_at
        FROM users u
        FULL OUTER JOIN summary s ON s.user_id = u.id
        WHERE u.deleted_at IS NULL OR u.id IS NULL
        ORDER BY ${creatorOrderBy(order)}`);
}

export async function queryUserGenerations(sql, {
    userId,
    limit = 200,
    before = null,
    beforeId = null,
    projectId = null,
} = {}) {
    return sql`SELECT e.task_id, e.model_id, e.resolution, e.duration, e.ratio, e.mode,
            e.status, e.created_at, e.category, e.image_key, e.image_prompt, e.images,
            e.project_id, project.name AS project_name,
            timing.id AS gateway_id, timing.created_at AS submitted_at,
            CASE WHEN timing.status = 'succeeded' THEN timing.finished_at END AS finished_at,
            prompt.user_prompt, prompt.generated_prompt, prompt.style, prompt.refs, prompt.liked,
            exr.result->>'url' AS exr_url,
            exr.result->>'archiveKey' AS exr_archive_key,
            coalesce(exr.result->'metadata'->>'resolution', exr.request_body->>'resolution') AS exr_resolution
        FROM gallery_generations e
        LEFT JOIN seedance_prompts prompt ON prompt.task_id = e.task_id
        LEFT JOIN projects project ON project.id = e.project_id
        -- The gallery's created_at is the queue start time. Keep its cursor
        -- unchanged and carry the job's actual submission separately for
        -- generation timing. Legacy usage-only tasks have no timing record.
        LEFT JOIN LATERAL (
            SELECT j.id, j.created_at, j.finished_at, j.status
            FROM jobs j
            WHERE j.provider_task_id = e.task_id AND j.user_id = e.user_id
            ORDER BY j.id DESC
            LIMIT 1
        ) timing ON true
        LEFT JOIN LATERAL (
            SELECT x.result, x.request_body
            FROM exr_jobs x
            WHERE x.user_id = e.user_id
                AND x.status = 'succeeded'
                AND coalesce(x.request_body->'_gallery'->>'sourceTaskId', x.request_body->'_billing'->>'sourceTaskId') = e.task_id
            ORDER BY x.finished_at DESC NULLS LAST, x.id DESC
            LIMIT 1
        ) exr ON true
        WHERE e.user_id = ${userId} AND e.task_id IS NOT NULL
            AND e.status <> 'failed' AND coalesce(prompt.deleted, false) = false
            -- Try-On generations live only in the Try-On tool's own history
            -- page — never in the studio rail, gallery, or studio pickers,
            -- which all read through this query.
            AND coalesce(e.mode, '') <> 'tryon'
            -- Keyset cursor with task_id as tiebreaker: batch ×N jobs share a
            -- created_at to the microsecond, and a bare created_at < before
            -- silently skipped the tied rows at every page boundary.
            AND (${before}::timestamptz IS NULL
                OR e.created_at < ${before}::timestamptz
                OR (${beforeId}::text IS NOT NULL
                    AND e.created_at = ${before}::timestamptz
                    AND e.task_id < ${beforeId}::text))
            AND (${projectId}::integer IS NULL OR e.project_id = ${projectId})
        ORDER BY e.created_at DESC, e.task_id DESC
        LIMIT ${limit}`;
}

export async function queryProjectGenerations(sql, { projectId, limit = 60, before = null, beforeId = null } = {}) {
    return sql`SELECT e.task_id, e.user_id,
            coalesce(u.name, split_part(coalesce(u.email, e.user_email), '@', 1)) AS creator_name,
            coalesce(u.email, e.user_email) AS creator_email,
            e.model_id, e.resolution, e.duration, e.ratio, e.mode,
            e.status, e.created_at, e.category, e.image_key, e.image_prompt, e.images,
            e.project_id, project.name AS project_name,
            timing.id AS gateway_id, timing.created_at AS submitted_at,
            CASE WHEN timing.status = 'succeeded' THEN timing.finished_at END AS finished_at,
            prompt.user_prompt, prompt.generated_prompt, prompt.style, prompt.refs, prompt.liked,
            exr.result->>'url' AS exr_url, exr.result->>'archiveKey' AS exr_archive_key,
            coalesce(exr.result->'metadata'->>'resolution', exr.request_body->>'resolution') AS exr_resolution
        FROM gallery_generations e
        LEFT JOIN users u ON u.id = e.user_id
        LEFT JOIN seedance_prompts prompt ON prompt.task_id = e.task_id
        LEFT JOIN projects project ON project.id = e.project_id
        LEFT JOIN LATERAL (
            SELECT j.id, j.created_at, j.finished_at, j.status FROM jobs j
            WHERE j.provider_task_id = e.task_id AND j.user_id = e.user_id ORDER BY j.id DESC LIMIT 1
        ) timing ON true
        LEFT JOIN LATERAL (
            SELECT x.result, x.request_body FROM exr_jobs x
            WHERE x.user_id = e.user_id AND x.status = 'succeeded'
                AND coalesce(x.request_body->'_gallery'->>'sourceTaskId', x.request_body->'_billing'->>'sourceTaskId') = e.task_id
            ORDER BY x.finished_at DESC NULLS LAST, x.id DESC LIMIT 1
        ) exr ON true
        WHERE e.project_id = ${projectId} AND project.archived_at IS NULL
            AND e.task_id IS NOT NULL AND e.status <> 'failed'
            AND coalesce(prompt.deleted, false) = false AND coalesce(e.mode, '') <> 'tryon'
            AND (${before}::timestamptz IS NULL OR e.created_at < ${before}::timestamptz
                OR (${beforeId}::text IS NOT NULL AND e.created_at = ${before}::timestamptz AND e.task_id < ${beforeId}::text))
        ORDER BY e.created_at DESC, e.task_id DESC LIMIT ${limit}`;
}

export async function queryProjectGenerationSummary(sql, { projectId } = {}) {
    const [row] = await sql`SELECT project.id, project.name, count(e.task_id)::int AS generations,
            count(e.task_id) FILTER (WHERE e.category = 'image')::int AS images,
            count(e.task_id) FILTER (WHERE e.category <> 'image')::int AS videos
        FROM projects project
        LEFT JOIN gallery_generations e ON e.project_id = project.id AND e.task_id IS NOT NULL
            AND e.status <> 'failed' AND coalesce(e.mode, '') <> 'tryon'
        LEFT JOIN seedance_prompts prompt ON prompt.task_id = e.task_id
        WHERE project.id = ${projectId} AND project.archived_at IS NULL
            AND (e.task_id IS NULL OR coalesce(prompt.deleted, false) = false)
        GROUP BY project.id, project.name`;
    return row ?? null;
}

export async function queryGalleryProjects(sql) {
    return sql`SELECT project.id, project.name,
            count(e.task_id)::int AS generations,
            count(e.task_id) FILTER (WHERE e.category = 'image')::int AS images,
            count(e.task_id) FILTER (WHERE e.category <> 'image')::int AS videos,
            max(e.created_at) AS last_generation_at
        FROM projects project
        LEFT JOIN gallery_generations e ON e.project_id = project.id AND e.task_id IS NOT NULL
            AND e.status <> 'failed' AND coalesce(e.mode, '') <> 'tryon'
        LEFT JOIN seedance_prompts prompt ON prompt.task_id = e.task_id
        WHERE project.archived_at IS NULL
            AND (e.task_id IS NULL OR coalesce(prompt.deleted, false) = false)
        GROUP BY project.id, project.name
        HAVING count(e.task_id) > 0
        ORDER BY last_generation_at DESC NULLS LAST, project.name ASC`;
}

export async function queryUserGenerationProjects(sql, { userId } = {}) {
    return sql`SELECT e.project_id, coalesce(project.name, 'Unassigned') AS project_name,
            count(*)::int AS generations,
            count(*) FILTER (WHERE e.category = 'image')::int AS images,
            count(*) FILTER (WHERE e.category <> 'image')::int AS videos
        FROM gallery_generations e
        LEFT JOIN seedance_prompts prompt ON prompt.task_id = e.task_id
        LEFT JOIN projects project ON project.id = e.project_id
        WHERE e.user_id = ${userId} AND e.task_id IS NOT NULL
            AND e.status <> 'failed' AND coalesce(prompt.deleted, false) = false
            AND coalesce(e.mode, '') <> 'tryon'
        GROUP BY e.project_id, project.name
        ORDER BY generations DESC, project_name ASC`;
}
