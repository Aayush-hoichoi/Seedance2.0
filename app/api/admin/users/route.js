import { NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { listCreators } from '../../../../lib/access/db.js';

// Admin: every user on the platform (same query the gallery uses — name,
// email, role, generation count, last activity), plus the caller's own id so
// the UI can disable self-targeting actions.

export const runtime = 'nodejs';

export async function GET() {
    const admin = await getUser();
    if (!admin || admin.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    try {
        const users = await listCreators();
        return NextResponse.json({ me: admin.userId, users });
    } catch (e) {
        console.error('[admin/users] list failed:', e.message);
        return NextResponse.json({ error: 'Could not load users.' }, { status: 502 });
    }
}
