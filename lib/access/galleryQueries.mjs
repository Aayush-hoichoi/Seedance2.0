// Gallery reads kept separate from the connection wrapper so the SQL can be
// exercised against a real Postgres in tests. `gallery_generations.project_id`
// is canonical for both image and video jobs; seedance_prompts has no row for
// images and therefore must never be used as the source of project ownership.

export async function queryUserGenerations(sql, {
    userId,
    limit = 200,
    before = null,
    projectId = null,
} = {}) {
    return sql`SELECT e.task_id, e.model_id, e.resolution, e.duration, e.ratio, e.mode,
            e.status, e.created_at, e.category, e.image_key, e.image_prompt,
            e.project_id, project.name AS project_name,
            prompt.user_prompt, prompt.generated_prompt, prompt.style, prompt.refs, prompt.liked,
            exr.result->>'url' AS exr_url,
            exr.result->>'archiveKey' AS exr_archive_key
        FROM gallery_generations e
        LEFT JOIN seedance_prompts prompt ON prompt.task_id = e.task_id
        LEFT JOIN projects project ON project.id = e.project_id
        LEFT JOIN LATERAL (
            SELECT x.result
            FROM exr_jobs x
            WHERE x.user_id = e.user_id
                AND x.status = 'succeeded'
                AND x.request_body->'_gallery'->>'sourceTaskId' = e.task_id
            ORDER BY x.finished_at DESC NULLS LAST, x.id DESC
            LIMIT 1
        ) exr ON true
        WHERE e.user_id = ${userId} AND e.task_id IS NOT NULL
            AND e.status <> 'failed' AND coalesce(prompt.deleted, false) = false
            AND e.created_at < coalesce(${before}::timestamptz, 'infinity'::timestamptz)
            AND (${projectId}::integer IS NULL OR e.project_id = ${projectId})
        ORDER BY e.created_at DESC
        LIMIT ${limit}`;
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
        GROUP BY e.project_id, project.name
        ORDER BY generations DESC, project_name ASC`;
}
