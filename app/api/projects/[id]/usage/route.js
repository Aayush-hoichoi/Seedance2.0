import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../../lib/gateway/authz.js';
import { usageRollup, toCsv } from '../../../../../lib/gateway/usageQuery.js';

export const runtime = 'nodejs';

// Project usage rollups: ?group_by=user|model|day&from=&to=&format=csv
export async function GET(request, { params }) {
    const { id } = await params;
    const auth = await gatewayContext({ projectId: Number(id), permission: 'usage.view' });
    if (!auth.ok) return auth.response;
    const { sql, org, project } = auth.ctx;
    const url = new URL(request.url);
    const rows = await usageRollup(sql, {
        orgId: org.id, projectId: project.id,
        groupBy: url.searchParams.get('group_by') || 'model',
        from: url.searchParams.get('from'), to: url.searchParams.get('to'),
    });
    if (url.searchParams.get('format') === 'csv') {
        return new NextResponse(toCsv(rows), {
            headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="project-${project.id}-usage.csv"` },
        });
    }
    return NextResponse.json({ items: rows });
}
