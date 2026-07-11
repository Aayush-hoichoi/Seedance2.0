import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../lib/gateway/authz.js';
import { toCsv } from '../../../../lib/gateway/usageQuery.js';

export const runtime = 'nodejs';

// Audit trail (admin): ?actor=&action=&target=&from=&to=&format=csv
export async function GET(request) {
    const auth = await gatewayContext({ permission: 'audit.view' });
    if (!auth.ok) return auth.response;
    const { sql } = auth.ctx;
    const url = new URL(request.url);
    const rows = await sql.query(
        `SELECT * FROM audit_log
         WHERE ($1::text IS NULL OR actor_id = $1 OR actor_email ILIKE '%' || $1 || '%')
           AND ($2::text IS NULL OR action ILIKE $2 || '%')
           AND ($3::text IS NULL OR target_type = $3)
           AND ($4::timestamptz IS NULL OR created_at >= $4)
           AND ($5::timestamptz IS NULL OR created_at < $5)
         ORDER BY created_at DESC LIMIT 500`,
        [
            url.searchParams.get('actor'), url.searchParams.get('action'),
            url.searchParams.get('target'), url.searchParams.get('from'), url.searchParams.get('to'),
        ],
    );
    if (url.searchParams.get('format') === 'csv') {
        const flat = rows.map((r) => ({ ...r, before: JSON.stringify(r.before), after: JSON.stringify(r.after) }));
        return new NextResponse(toCsv(flat), {
            headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="audit-log.csv"' },
        });
    }
    return NextResponse.json({ items: rows });
}
