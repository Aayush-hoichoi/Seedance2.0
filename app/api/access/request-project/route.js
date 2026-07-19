import { NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { requestProject } from '../../../../lib/access/projectRequests.mjs';
import { notifySlackProjectRequested } from '../../../../lib/notify/slack.mjs';

export const runtime = 'nodejs';

// Any signed-in member may ASK for a new project; creation itself stays
// admin-gated (POST /api/projects). Approval adds the requester to it.
export async function POST(request) {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!user.email) return NextResponse.json({ error: 'No email on your account.' }, { status: 400 });
    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }); }
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name.length < 2 || name.length > 60) {
        return NextResponse.json({ error: 'Project name must be 2–60 characters.' }, { status: 400 });
    }
    const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : null;
    const { id, status, fresh } = await requestProject(user.userId, user.email, name, note);
    if (status === 'exists') {
        return NextResponse.json({ error: 'A project with that name already exists — ask an admin to add you to it.' }, { status: 400 });
    }
    // Ping Slack only on a FRESH ask — a duplicate over a still-pending request
    // must not re-ping the channel. The id rides the Approve/Deny buttons.
    if (fresh) {
        await notifySlackProjectRequested({ id, email: user.email, name, note }).catch(() => {});
    }
    return NextResponse.json({ ok: true, status, fresh });
}
