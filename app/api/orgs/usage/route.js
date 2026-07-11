import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../lib/gateway/authz.js';
import { usageRollup, toCsv } from '../../../../lib/gateway/usageQuery.js';

export const runtime = 'nodejs';

// Org-wide rollups (admin): ?group_by=project|user|model|day|provider
export async function GET(request) {
    const auth = await gatewayContext({ permission: 'usage.view' });
    if (!auth.ok) return auth.response;
    const { sql, org, role } = auth.ctx;
    if (role !== 'admin') {
        // Non-admins only get org rollups if they hold usage.view via a project —
        // scope them to project routes instead.
        return NextResponse.json({ code: 'FORBIDDEN', message: 'Org rollups are admin-only.' }, { status: 403 });
    }
    const url = new URL(request.url);
    const rows = await usageRollup(sql, {
        orgId: org.id,
        groupBy: url.searchParams.get('group_by') || 'project',
        from: url.searchParams.get('from'), to: url.searchParams.get('to'),
    });
    if (url.searchParams.get('format') === 'csv') {
        return new NextResponse(toCsv(rows), {
            headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="org-usage.csv"' },
        });
    }
    return NextResponse.json({ items: rows });
}
