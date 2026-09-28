import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../lib/gateway/authz.js';

export const runtime = 'nodejs';

// Everything about the SIGNED-IN user across every workspace — the data
// behind the bottom-left profile panel. Self-scoped by construction: every
// query keys on the caller's own user id, so there is nothing to authorize
// beyond being signed in (admins see their own profile the same way).
export async function GET() {
    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { sql, user } = auth.ctx;
    const me = user.userId;

    const [identity] = await sql`SELECT id, email, name, role, created_at FROM users WHERE id = ${me}`;

    // Projects the user belongs to (active ones).
    const memberships = await sql`
        SELECT p.id, p.name,
               (SELECT count(*)::int FROM project_memberships m2 WHERE m2.project_id = p.id) AS member_count
        FROM project_memberships m JOIN projects p ON p.id = m.project_id
        WHERE m.user_id = ${me} AND p.archived_at IS NULL
        ORDER BY p.name`;

    // The full spend matrix: (project × model) → spent + generations. The
    // client rolls this up per project and per model; keeping ONE source
    // means every rollup reconciles by construction. Same event types and
    // window as every other spend figure in the app.
    const spend = await sql`
        SELECT b.project_id,
               coalesce(p.name, 'Deleted project')                                AS project_name,
               b.model_id,
               coalesce(mo.display_name, b.model_id, 'unknown')                   AS model_name,
               coalesce(SUM(coalesce(b.cost_usd, b.est_cost_usd, 0)), 0)::float8  AS spent_usd,
               count(*)::int                                                      AS generations,
               coalesce(SUM(coalesce(b.cost_usd, b.est_cost_usd, 0))
                   FILTER (WHERE b.created_at >= date_trunc('month', now())), 0)::float8 AS month_usd
        FROM billing_events b
        LEFT JOIN projects p ON p.id = b.project_id
        LEFT JOIN models mo ON mo.id = b.model_id
        WHERE b.user_id = ${me} AND b.event_type IN ('settlement', 'failure')
        GROUP BY b.project_id, p.name, b.model_id, mo.display_name
        ORDER BY spent_usd DESC`;

    return NextResponse.json({
        user: {
            id: me,
            email: identity?.email ?? user.email ?? null,
            name: identity?.name ?? user.name ?? null,
            role: identity?.role ?? user.role ?? 'member',
            createdAt: identity?.created_at ?? null,
        },
        memberships,
        spend,
    });
}
