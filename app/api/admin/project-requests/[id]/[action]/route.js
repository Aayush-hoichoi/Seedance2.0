import { NextResponse } from 'next/server';
import { getUser } from '../../../../../../lib/auth/user.js';
import { approveProjectRequest, denyProjectRequest } from '../../../../../../lib/access/projectRequests.mjs';
import { notifySlackProjectDecided } from '../../../../../../lib/notify/slack.mjs';

export const runtime = 'nodejs';

// approve: creates the project and adds the requester (idempotent — see
// projectRequests.mjs). deny: closes the request; nothing is created.
export async function POST(request, { params }) {
    const admin = await getUser();
    if (!admin || admin.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const { id, action } = await params;
    if (action !== 'approve' && action !== 'deny') {
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
    const requestId = Number(id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
        return NextResponse.json({ error: 'Invalid request id' }, { status: 400 });
    }
    const row = action === 'approve'
        ? await approveProjectRequest(requestId, { actorId: admin.userId, actorEmail: admin.email })
        : await denyProjectRequest(requestId, admin.email);
    if (!row) return NextResponse.json({ error: 'Request not found — it may already have been handled.' }, { status: 404 });
    await notifySlackProjectDecided({ email: row.user_email, name: row.name, status: row.status }).catch(() => {});
    return NextResponse.json({ ok: true, request: row });
}
