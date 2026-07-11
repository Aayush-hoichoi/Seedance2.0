import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db/neon.js';
import { sweep } from '../../../../lib/gateway/sweep.mjs';

// The single daily Vercel cron (Hobby plan allows 1/day): materializes
// yesterday's billing events into usage_rollups_daily and runs a forced
// sweep as the day's safety net for anything traffic didn't catch.
// Auth: Vercel sends `Authorization: Bearer ${CRON_SECRET}` when set.

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(request) {
    // Fail CLOSED: this route is exempt from the Clerk gate, so a missing
    // CRON_SECRET must mean "locked", never "open to anyone".
    const secret = process.env.CRON_SECRET;
    if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'Unauthorized (set CRON_SECRET and configure the Vercel cron)' }, { status: 401 });
    }
    const sql = await getDb();
    if (!sql) return NextResponse.json({ error: 'DB not configured' }, { status: 503 });

    // Re-materialize the last 2 days (idempotent upsert) so late settlements
    // from around midnight are never lost.
    const rows = await sql`
        INSERT INTO usage_rollups_daily
            (day, org_id, project_id, user_id, model_id, provider_id,
             generations, failures, video_seconds, images, cost_usd)
        SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
               org_id, project_id, user_id, model_id, COALESCE(provider_id, 'unknown'),
               count(*) FILTER (WHERE event_type = 'settlement')::int,
               count(*) FILTER (WHERE event_type = 'failure')::int,
               COALESCE(SUM(COALESCE((units->>'video_seconds')::numeric, 0)), 0),
               COALESCE(SUM(COALESCE((units->>'images')::numeric, 0)), 0)::int,
               COALESCE(SUM(COALESCE(cost_usd, est_cost_usd, 0)), 0)
        FROM billing_events
        WHERE event_type IN ('settlement', 'failure')
          AND created_at >= (now() AT TIME ZONE 'UTC')::date - interval '2 days'
        GROUP BY 1, org_id, project_id, user_id, model_id, COALESCE(provider_id, 'unknown')
        ON CONFLICT (day, org_id, project_id, user_id, model_id, provider_id) DO UPDATE SET
            generations = EXCLUDED.generations, failures = EXCLUDED.failures,
            video_seconds = EXCLUDED.video_seconds, images = EXCLUDED.images,
            cost_usd = EXCLUDED.cost_usd
        RETURNING day`;

    await sweep({ force: true }).catch(() => {});
    return NextResponse.json({ ok: true, rolledUp: rows.length });
}
