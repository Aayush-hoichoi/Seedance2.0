import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../../lib/gateway/authz.js';
import { apiError } from '../../../../../lib/gateway/httpError.mjs';

export const runtime = 'nodejs';

// Archived projects are only visible to platform admins. Project membership
// and usage history remain intact while archived.
export async function GET() {
    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { sql, isPlatformAdmin } = auth.ctx;
    if (!isPlatformAdmin) return apiError('FORBIDDEN', 'Only admins can view archived projects.');

    const items = await sql`SELECT p.id, p.name, p.archived_at, p.created_at,
        (SELECT count(*)::int FROM project_memberships m WHERE m.project_id = p.id) AS member_count,
        (SELECT count(*)::int FROM jobs j WHERE j.project_id = p.id) AS job_count,
        (SELECT COALESCE(SUM(COALESCE(b.cost_usd, b.est_cost_usd, 0)), 0)::float8
            FROM billing_events b WHERE b.project_id = p.id AND b.event_type IN ('settlement', 'failure')) AS spent_usd
        FROM projects p WHERE p.archived_at IS NOT NULL
        ORDER BY p.archived_at DESC, p.name`;
    return NextResponse.json({ items, isPlatformAdmin: true });
}
