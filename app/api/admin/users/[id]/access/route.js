import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../../../lib/gateway/authz.js';
import { userSpendByProjectModel } from '../../../../../../lib/gateway/usageQuery.js';
import { buildUserAccessReport } from '../../../../../../lib/gateway/userAccessReport.mjs';
import { usageForQuotas } from '../../../../../../lib/gateway/db.js';

// One user's whole governance picture in a single payload for the Access
// explorer: every project they belong to (or spent in), effective model
// access per project — computed with the gateway's own effectiveAccess, never
// re-derived — spend per (project, model), and their personal budgets with
// live used/reserved.

export const runtime = 'nodejs';

export async function GET(_request, { params }) {
    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { sql, isPlatformAdmin } = auth.ctx;
    if (!isPlatformAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const { id } = await params;
    if (!id || typeof id !== 'string' || id.length > 200) {
        return NextResponse.json({ error: 'Invalid user id.' }, { status: 400 });
    }

    try {
        const [userRow] = await sql`SELECT id, email, name, role FROM users WHERE id = ${id} AND deleted_at IS NULL`;
        if (!userRow) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

        const now = new Date();
        const [memberships, models, overrides, spendRows, userQuotas] = await Promise.all([
            sql`SELECT pm.project_id, p.name, p.paused, p.archived_at
                FROM project_memberships pm JOIN projects p ON p.id = pm.project_id
                WHERE pm.user_id = ${id}`,
            sql`SELECT id, display_name, category, is_default FROM models WHERE active = true ORDER BY display_name`,
            sql`SELECT * FROM user_model_overrides WHERE user_id = ${id}`,
            userSpendByProjectModel(sql, { userId: id }),
            sql`SELECT q.*, p.name AS project_name, m.display_name AS model_name
                FROM quotas q
                LEFT JOIN projects p ON p.id = q.project_id
                LEFT JOIN models m ON m.id = q.model_id
                WHERE q.deleted_at IS NULL AND q.user_id = ${id}`,
        ]);
        const grants = memberships.length
            ? await sql`SELECT * FROM project_model_grants
                        WHERE project_id = ANY(${memberships.map((m) => m.project_id)}::int[])`
            : [];

        const projects = buildUserAccessReport({ memberships, models, grants, overrides, spendRows, now });
        const { usedByQuota, reservedByQuota } = await usageForQuotas(sql, userQuotas, now);
        const quotas = userQuotas.map((q) => ({
            ...q,
            hard_limit: Number(q.hard_limit),
            used: usedByQuota[q.id] ?? 0,
            reserved: reservedByQuota[q.id] ?? 0,
        }));

        return NextResponse.json({
            user: userRow,
            models,
            projects,
            quotas,
            totals: {
                cost_usd: projects.reduce((s, p) => s + p.cost_usd, 0),
                generations: projects.reduce((s, p) => s + p.generations, 0),
                failures: projects.reduce((s, p) => s + p.failures, 0),
            },
        });
    } catch (e) {
        console.error('[admin/users/access] report failed:', e.message);
        return NextResponse.json({ error: 'Could not load the access report.' }, { status: 502 });
    }
}
