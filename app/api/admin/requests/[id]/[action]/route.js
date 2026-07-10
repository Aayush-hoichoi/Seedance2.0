import { NextResponse } from 'next/server';
import { getUser } from '../../../../../../lib/auth/user.js';
import { setRequestStatus } from '../../../../../../lib/access/db.js';
import { nextStatus } from '../../../../../../lib/access/requestStatus.mjs';

export const runtime = 'nodejs';

export async function POST(_request, { params }) {
    const admin = await getUser();
    if (!admin || admin.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const { id, action } = await params;
    if (action !== 'approve' && action !== 'revoke') {
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
    const row = await setRequestStatus(Number(id), nextStatus(action), admin.email);
    if (!row) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    return NextResponse.json({ ok: true, request: row });
}
