import { NextResponse } from 'next/server';
import { isAdmin } from '../../../../lib/auth/user.js';
import { listPendingProjectRequests } from '../../../../lib/access/projectRequests.mjs';

export const runtime = 'nodejs';

export async function GET() {
    if (!(await isAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    return NextResponse.json({ requests: await listPendingProjectRequests() });
}
