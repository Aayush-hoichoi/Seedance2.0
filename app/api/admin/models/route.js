import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../lib/gateway/authz.js';

export const runtime = 'nodejs';

// Lightweight catalog for admin forms. Keep this independent from quota usage
// aggregation so a slow budget rollup cannot leave model selectors empty.
export async function GET() {
    const auth = await gatewayContext({ permission: 'quota.manage' });
    if (!auth.ok) return auth.response;
    const { sql } = auth.ctx;
    const items = await sql`SELECT id, display_name, category FROM models
        WHERE active = true ORDER BY category, display_name`;
    return NextResponse.json({ items });
}
