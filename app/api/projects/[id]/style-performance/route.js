import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../../lib/gateway/authz.js';

export const runtime = 'nodejs';

// Does the project style actually help? Like rate per (look, version) against
// the project's own unstyled baseline.
//
// This is the whole point of stamping style_look/style_version onto every job:
// without an attributable cohort, "the style is working" is an opinion. The
// baseline row (style_look IS NULL) is the project's own history, so the
// comparison is against how this team was already doing — not a global average.
export async function GET(request, { params }) {
    const { id } = await params;
    const auth = await gatewayContext({ projectId: Number(id), permission: 'usage.view' });
    if (!auth.ok) return auth.response;
    const { sql, project } = auth.ctx;

    const rows = await sql`
        SELECT style_look, style_version,
               count(*)::int                                  AS generations,
               count(*) FILTER (WHERE likes > 0)::int          AS liked,
               sum(downloads)::int                             AS downloads
        FROM dataset_samples
        WHERE project_id = ${project.id}
        GROUP BY style_look, style_version
        -- Baseline first, then newest style version: the reader is comparing
        -- each version against the row above it.
        ORDER BY style_version NULLS FIRST, style_look`;

    const items = rows.map((row) => ({
        ...row,
        like_rate: row.generations ? row.liked / row.generations : 0,
    }));
    const baseline = items.find((row) => row.style_look === null) ?? null;
    return NextResponse.json({ items, baselineLikeRate: baseline?.like_rate ?? null });
}
