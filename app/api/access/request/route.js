import { NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { requestAccess } from '../../../../lib/access/db.js';
import { getDb } from '../../../../lib/db/neon.js';
import { GATED_MODEL_IDS, IMAGE_GATED_MODEL_IDS } from '../../../../lib/seedance/constants.js';
import { notifySlackAccessRequested } from '../../../../lib/notify/slack.mjs';

export const runtime = 'nodejs';

export async function POST(request) {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }); }
    const { modelId, note, projectId } = body || {};
    if (!GATED_MODEL_IDS.includes(modelId) && !IMAGE_GATED_MODEL_IDS.includes(modelId)) {
        return NextResponse.json({ error: 'That model does not require a request.' }, { status: 400 });
    }
    if (!user.email) return NextResponse.json({ error: 'No email on your account.' }, { status: 400 });
    // The request is scoped to a project — approval grants access there. Require
    // it and verify membership so a crafted call can't request for a project the
    // user isn't in (the studio always sends the user's current project).
    const pid = Number.isInteger(projectId) ? projectId : Number(projectId);
    if (!Number.isInteger(pid) || pid <= 0) {
        return NextResponse.json({ error: 'A project is required to request access.' }, { status: 400 });
    }
    const sql = await getDb();
    if (!sql) return NextResponse.json({ error: 'Access store unavailable.' }, { status: 503 });
    const [member] = await sql`SELECT p.name FROM project_memberships m
        JOIN projects p ON p.id = m.project_id
        WHERE m.project_id = ${pid} AND m.user_id = ${user.userId} LIMIT 1`;
    if (!member) return NextResponse.json({ error: 'You are not a member of that project.' }, { status: 403 });
    const cleanNote = typeof note === 'string' ? note.slice(0, 500) : null;
    const status = await requestAccess(user.userId, user.email, modelId, cleanNote, pid);
    // Post to Slack only on a fresh pending request — a no-op re-request over an
    // already-approved grant returns 'approved' and must not ping anyone.
    if (status === 'pending') {
        await notifySlackAccessRequested({ email: user.email, modelId, projectName: member.name, note: cleanNote }).catch(() => {});
    }
    return NextResponse.json({ ok: true, status });
}
