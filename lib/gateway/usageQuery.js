// Shared usage aggregation over billing_events settlements/failures.
// group_by: user | model | day | provider | project | day_user | user_model.
// Window: from/to ISO.

// Humans see emails, not Clerk ids; costs leave Postgres as float8 so the
// charts (Recharts ignores string numerics) always get numbers.
const GROUP_COLS = {
    user: 'COALESCE(u.email, b.user_id)',
    model: 'b.model_id',
    provider: 'b.provider_id',
    // ponytail: same-named projects would merge into one row; key by id + a
    // separate name column if duplicate project names ever become a thing.
    project: 'COALESCE(p.name, b.project_id::text)',
    day: `to_char(b.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
};

export async function usageRollup(sql, { projectId = null, groupBy = 'model', from = null, to = null }) {
    // day_user: one row per (day, user) so charts can draw a spend line per
    // user. user_model is the same two-dimensional shape for detailed hover
    // breakdowns on per-user bars.
    const isDayUser = groupBy === 'day_user';
    const isUserModel = groupBy === 'user_model';
    const hasSeries = isDayUser || isUserModel;
    const col = isDayUser
        ? GROUP_COLS.day
        : isUserModel
            ? GROUP_COLS.user
            : (GROUP_COLS[groupBy] || GROUP_COLS.model);
    const seriesCol = isDayUser ? GROUP_COLS.user : 'COALESCE(m.display_name, b.model_id)';
    const rows = await sql.query(
        `SELECT ${col} AS key,${hasSeries ? ` ${seriesCol} AS series,` : ''}
                count(*) FILTER (WHERE b.event_type = 'settlement')::int AS generations,
                count(*) FILTER (WHERE b.event_type = 'failure')::int AS failures,
                COALESCE(SUM(COALESCE((b.units->>'video_seconds')::numeric, 0)), 0)::float8 AS video_seconds,
                COALESCE(SUM(COALESCE((b.units->>'images')::numeric, 0)), 0)::int AS images,
                COALESCE(SUM(COALESCE(b.cost_usd, b.est_cost_usd, 0)), 0)::float8 AS cost_usd
         FROM billing_events b
         LEFT JOIN users u ON u.id = b.user_id
         ${isUserModel ? 'LEFT JOIN models m ON m.id = b.model_id' : ''}
         ${groupBy === 'project' ? 'LEFT JOIN projects p ON p.id = b.project_id' : ''}
         WHERE b.event_type IN ('settlement', 'failure')
           AND ($1::int IS NULL OR b.project_id = $1)
           AND ($2::timestamptz IS NULL OR b.created_at >= $2)
           AND ($3::timestamptz IS NULL OR b.created_at < $3)
         ${hasSeries ? 'GROUP BY 1, 2 ORDER BY 1, cost_usd DESC' : 'GROUP BY 1 ORDER BY cost_usd DESC'}`,
        [projectId, from, to],
    );
    return rows;
}

// Admin project usage bars need the total and its per-model composition in one
// response. Returning the nested rows atomically avoids a client-side join on
// user labels (and guarantees the hover detail matches the rendered bar).
export async function userUsageWithModelBreakdown(sql, { projectId, from = null, to = null }) {
    return sql.query(
        `WITH per_user_model AS (
            SELECT COALESCE(u.email, b.user_id) AS user_key,
                   b.model_id,
                   COALESCE(m.display_name, b.model_id) AS model_name,
                   count(*) FILTER (WHERE b.event_type = 'settlement')::int AS generations,
                   count(*) FILTER (WHERE b.event_type = 'failure')::int AS failures,
                   COALESCE(SUM(COALESCE((b.units->>'video_seconds')::numeric, 0)), 0)::float8 AS video_seconds,
                   COALESCE(SUM(COALESCE((b.units->>'images')::numeric, 0)), 0)::int AS images,
                   COALESCE(SUM(COALESCE(b.cost_usd, b.est_cost_usd, 0)), 0)::float8 AS cost_usd
            FROM billing_events b
            LEFT JOIN users u ON u.id = b.user_id
            LEFT JOIN models m ON m.id = b.model_id
            WHERE b.event_type IN ('settlement', 'failure')
              AND b.project_id = $1
              AND ($2::timestamptz IS NULL OR b.created_at >= $2)
              AND ($3::timestamptz IS NULL OR b.created_at < $3)
            GROUP BY 1, b.model_id, m.display_name
        )
        SELECT user_key AS key,
               SUM(generations)::int AS generations,
               SUM(failures)::int AS failures,
               SUM(video_seconds)::float8 AS video_seconds,
               SUM(images)::int AS images,
               SUM(cost_usd)::float8 AS cost_usd,
               jsonb_agg(jsonb_build_object(
                   'model_id', model_id,
                   'model_name', model_name,
                   'cost_usd', cost_usd,
                   'generations', generations,
                   'failures', failures,
                   'video_seconds', video_seconds,
                   'images', images
               ) ORDER BY cost_usd DESC) AS model_breakdown
        FROM per_user_model
        GROUP BY user_key
        ORDER BY cost_usd DESC`,
        [projectId, from, to],
    );
}

export function toCsv(rows) {
    if (!rows?.length) return 'key,generations,failures,video_seconds,images,cost_usd\n';
    const headers = Object.keys(rows[0]);
    const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
    return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n') + '\n';
}
