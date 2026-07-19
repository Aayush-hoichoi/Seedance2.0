// Shared usage aggregation over billing_events settlements/failures.
// group_by: user | model | day | provider | project. Window: from/to ISO.

// Humans see emails, not Clerk ids; costs leave Postgres as float8 so the
// charts (Recharts ignores string numerics) always get numbers.
const GROUP_COLS = {
    user: 'COALESCE(u.email, b.user_id)',
    model: 'b.model_id',
    provider: 'b.provider_id',
    project: 'b.project_id',
    day: `to_char(b.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
};

export async function usageRollup(sql, { projectId = null, groupBy = 'model', from = null, to = null }) {
    // day_user: one row per (day, user) so charts can draw a spend line per
    // user. `key` stays the day (same as day); `series` names the line.
    const isDayUser = groupBy === 'day_user';
    const col = isDayUser ? GROUP_COLS.day : (GROUP_COLS[groupBy] || GROUP_COLS.model);
    const rows = await sql.query(
        `SELECT ${col} AS key,${isDayUser ? ` ${GROUP_COLS.user} AS series,` : ''}
                count(*) FILTER (WHERE b.event_type = 'settlement')::int AS generations,
                count(*) FILTER (WHERE b.event_type = 'failure')::int AS failures,
                COALESCE(SUM(COALESCE((b.units->>'video_seconds')::numeric, 0)), 0)::float8 AS video_seconds,
                COALESCE(SUM(COALESCE((b.units->>'images')::numeric, 0)), 0)::int AS images,
                COALESCE(SUM(COALESCE(b.cost_usd, b.est_cost_usd, 0)), 0)::float8 AS cost_usd
         FROM billing_events b
         LEFT JOIN users u ON u.id = b.user_id
         WHERE b.event_type IN ('settlement', 'failure')
           AND ($1::int IS NULL OR b.project_id = $1)
           AND ($2::timestamptz IS NULL OR b.created_at >= $2)
           AND ($3::timestamptz IS NULL OR b.created_at < $3)
         ${isDayUser ? 'GROUP BY 1, 2 ORDER BY 1' : 'GROUP BY 1 ORDER BY cost_usd DESC'}`,
        [projectId, from, to],
    );
    return rows;
}

export function toCsv(rows) {
    if (!rows?.length) return 'key,generations,failures,video_seconds,images,cost_usd\n';
    const headers = Object.keys(rows[0]);
    const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
    return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n') + '\n';
}
