import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../lib/gateway/authz.js';
import { listCreators } from '../../../../lib/access/db.js';

// Every user on the platform (same query the gallery uses — name, email, role,
// generation count, last activity), plus the caller's own id so the UI can
// disable self-targeting actions. Available to admins AND workspace managers:
// managers hold member.manage, so they need the roster to pick who to add to a
// project (the Add-member picker was empty for them otherwise).

export const runtime = 'nodejs';

export async function GET() {
    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { user, isPlatformAdmin, isOrgManager } = auth.ctx;
    if (!isPlatformAdmin && !isOrgManager) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    try {
        const users = await listCreators();
        return NextResponse.json({ me: user.userId, users });
    } catch (e) {
        console.error('[admin/users] list failed:', e.message);
        return NextResponse.json({ error: 'Could not load users.' }, { status: 502 });
    }
}
