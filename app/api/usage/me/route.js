import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../lib/gateway/authz.js';

export const runtime = 'nodejs';

// The signed-in user's spend on ONE project, broken down by model — the
// hover detail behind the MySpend chip. Same event types and all-time
// window as /api/projects' my_spent_usd, so the rows always sum to the
// number on the chip.
export async function GET(request) {
    const projectId = Number(new URL(request.url).searchParams.get('projectId'));
    if (!projectId) return NextResponse.json({ error: 'projectId is required.' }, { status: 400 });
    const auth = await gatewayContext({ projectId });
    if (!auth.ok) return auth.response;
    const { sql, user } = auth.ctx;
    const rows = await sql`
        SELECT b.model_id,
               coalesce(m.display_name, b.model_id, 'unknown')                    AS model_name,
               coalesce(SUM(coalesce(b.cost_usd, b.est_cost_usd, 0)), 0)::float8 AS spent_usd,
               count(*)::int                                                     AS generations
        FROM billing_events b
        LEFT JOIN models m ON m.id = b.model_id
        WHERE b.project_id = ${projectId} AND b.user_id = ${user.userId}
          AND b.event_type IN ('settlement', 'failure')
        GROUP BY b.model_id, m.display_name
        ORDER BY spent_usd DESC`;
    return NextResponse.json({ items: rows });
}
