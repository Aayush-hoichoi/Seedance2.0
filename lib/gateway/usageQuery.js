// Shared usage aggregation over billing_events settlements/failures.
// group_by: user | model | day | provider | project. Window: from/to ISO.

const GROUP_COLS = {
    user: 'user_id',
    model: 'model_id',
    provider: 'provider_id',
    project: 'project_id',
    day: `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
};

export async function usageRollup(sql, { orgId, projectId = null, groupBy = 'model', from = null, to = null }) {
    const col = GROUP_COLS[groupBy] || GROUP_COLS.model;
    const rows = await sql.query(
        `SELECT ${col} AS key,
                count(*) FILTER (WHERE event_type = 'settlement')::int AS generations,
                count(*) FILTER (WHERE event_type = 'failure')::int AS failures,
                COALESCE(SUM(COALESCE((units->>'video_seconds')::numeric, 0)), 0) AS video_seconds,
                COALESCE(SUM(COALESCE((units->>'images')::numeric, 0)), 0)::int AS images,
                COALESCE(SUM(COALESCE(cost_usd, est_cost_usd, 0)), 0) AS cost_usd
         FROM billing_events
         WHERE event_type IN ('settlement', 'failure')
           AND org_id = $1
           AND ($2::int IS NULL OR project_id = $2)
           AND ($3::timestamptz IS NULL OR created_at >= $3)
           AND ($4::timestamptz IS NULL OR created_at < $4)
         GROUP BY 1 ORDER BY cost_usd DESC`,
        [orgId, projectId, from, to],
    );
    return rows;
}

export function toCsv(rows) {
    if (!rows?.length) return 'key,generations,failures,video_seconds,images,cost_usd\n';
    const headers = Object.keys(rows[0]);
    const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
    return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n') + '\n';
}
