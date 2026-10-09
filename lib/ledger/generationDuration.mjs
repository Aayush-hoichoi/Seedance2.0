// Duration analytics use real job timestamps, never the output clip's length
// or spacing between submissions. Filter using the same shaped rows as the
// ledger, then aggregate the entire matching view before any page is selected.
// generation_ledger exposes jobs.created_at/finished_at unchanged; query those
// directly to avoid the view's unrelated prompt, billing and engagement joins.
// Legacy rows have no completion timestamp and cannot supply a timing.

export async function readGenerationDuration(sql, { rowsWhere, values }) {
    const rows = await sql.query(
        `WITH matching AS (
            SELECT row_key FROM ledger_rows ${rowsWhere}
        ), timed AS (
            SELECT m.row_key, j.created_at AS submitted_at, j.model_id, j.provider_id,
                   j.provider_task_id AS task_id,
                   extract(epoch FROM (j.finished_at - j.created_at))::float8 AS seconds
            FROM matching m
            JOIN jobs j ON j.id = substring(m.row_key from '^job:([0-9]{1,10})$')::bigint
            WHERE coalesce(j.request_body->>'category', 'video') <> 'image'
              AND j.status = 'succeeded'
              AND j.created_at IS NOT NULL AND j.finished_at IS NOT NULL
              AND isfinite(j.created_at) AND isfinite(j.finished_at)
              AND j.finished_at >= j.created_at
        ), interval_size AS (
            SELECT CASE
                WHEN max(submitted_at) - min(submitted_at) <= interval '2 days' THEN 900
                WHEN max(submitted_at) - min(submitted_at) <= interval '14 days' THEN 3600
                ELSE 86400
            END AS bucket_seconds
            FROM timed
        ), bucketed AS (
            SELECT timed.*, bucket_seconds,
                   date_bin(bucket_seconds * interval '1 second', submitted_at,
                            timestamptz '2000-01-01 00:00:00+05:30') AS bucket_start
            FROM timed CROSS JOIN interval_size
        )
        SELECT bucket_start, bucket_seconds,
               count(*)::int AS completed,
               sum(seconds)::float8 AS total_seconds,
               max(seconds)::float8 AS peak_seconds,
               (array_agg(model_id ORDER BY seconds DESC, row_key))[1] AS peak_model,
               (array_agg(provider_id ORDER BY seconds DESC, row_key))[1] AS peak_provider,
               (array_agg(task_id ORDER BY seconds DESC, row_key))[1] AS peak_task
        FROM bucketed
        GROUP BY bucket_start, bucket_seconds
        ORDER BY bucket_start`,
        values,
    );
    return shapeGenerationDuration(rows);
}

export function shapeGenerationDuration(rows) {
    const bucketSeconds = Number(rows[0]?.bucket_seconds || 900);
    const summary = { completed: 0, averageSeconds: null, peakSeconds: null, peakModel: null, peakProvider: null, peakTask: null };
    let totalSeconds = 0;
    const buckets = rows.map((row) => {
        const completed = Number(row.completed);
        const seconds = Number(row.total_seconds);
        const peakSeconds = Number(row.peak_seconds);
        totalSeconds += seconds;
        summary.completed += completed;
        if (summary.peakSeconds == null || peakSeconds > summary.peakSeconds) {
            summary.peakSeconds = peakSeconds;
            summary.peakModel = row.peak_model;
            summary.peakProvider = row.peak_provider;
            summary.peakTask = row.peak_task;
        }
        return {
            timestamp: new Date(row.bucket_start).getTime(),
            completed,
            averageMinutes: seconds / completed / 60,
            peakMinutes: peakSeconds / 60,
            peakModel: row.peak_model,
            peakProvider: row.peak_provider,
            peakTask: row.peak_task,
        };
    });
    if (summary.completed) summary.averageSeconds = totalSeconds / summary.completed;

    // A quiet interval is missing data, not a zero-minute generation. Explicit
    // nulls prevent the chart connecting separate bursts across an idle period.
    const series = [];
    for (const bucket of buckets) {
        const previous = series.at(-1);
        if (previous && bucket.timestamp - previous.timestamp > bucketSeconds * 1000) {
            series.push({
                timestamp: previous.timestamp + bucketSeconds * 1000,
                completed: 0, averageMinutes: null, peakMinutes: null,
            });
        }
        series.push(bucket);
    }
    return { bucketSeconds, summary, series };
}
