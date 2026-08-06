import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../../lib/gateway/authz.js';
import { apiError } from '../../../../../lib/gateway/httpError.mjs';
import { usageRollup, userUsageWithModelBreakdown, toCsv } from '../../../../../lib/gateway/usageQuery.js';

export const runtime = 'nodejs';

// Project usage rollups: ?group_by=user|model|day|user_model&from=&to=&format=csv
export async function GET(request, { params }) {
    const { id } = await params;
    const auth = await gatewayContext({ projectId: Number(id), permission: 'usage.view' });
    if (!auth.ok) return auth.response;
    const { sql, project } = auth.ctx;
    const url = new URL(request.url);
    const groupBy = url.searchParams.get('group_by') || 'model';
    const includeModelBreakdown = url.searchParams.get('include_model_breakdown') === '1';
    if ((groupBy === 'user_model' || includeModelBreakdown) && auth.ctx.role !== 'admin') {
        return apiError('FORBIDDEN', 'Detailed per-user model spend is available to admins only.');
    }
    if (includeModelBreakdown && groupBy !== 'user') {
        return apiError('BAD_REQUEST', 'include_model_breakdown is only supported with group_by=user.');
    }
    const query = {
        projectId: project.id,
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
    };
    const rows = includeModelBreakdown
        ? await userUsageWithModelBreakdown(sql, query)
        : await usageRollup(sql, { ...query, groupBy });
    if (url.searchParams.get('format') === 'csv') {
        return new NextResponse(toCsv(rows), {
            headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="project-${project.id}-usage.csv"` },
        });
    }
    return NextResponse.json({ items: rows });
}
