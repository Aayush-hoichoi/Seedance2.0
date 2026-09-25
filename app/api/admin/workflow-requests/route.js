import { NextResponse } from 'next/server';
import { isAdmin, getUser } from '../../../../lib/auth/user.js';
import { getDb } from '../../../../lib/db/neon.js';
import { writeAudit } from '../../../../lib/gateway/db.js';

export const runtime = 'nodejs';

// Pending workflow-access requests (one per user — approval unlocks every
// workflow), for the console Requests hub.
export async function GET() {
    if (!(await isAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const sql = await getDb();
    const requests = await sql`
        SELECT r.user_id, r.note, r.created_at, u.email AS user_email
        FROM workflow_access r
        LEFT JOIN users u ON u.id = r.user_id
        WHERE r.status = 'pending'
        ORDER BY r.created_at`;
    return NextResponse.json({ requests });
}

// Decide one: { userId, action: 'approve' | 'deny' }.
export async function PATCH(request) {
    if (!(await isAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const admin = await getUser();
    const sql = await getDb();
    const body = await request.json().catch(() => null);
    const userId = body?.userId;
    const action = body?.action;
    if (!userId || !['approve', 'deny'].includes(action)) {
        return NextResponse.json({ error: 'userId and action (approve|deny) are required.' }, { status: 400 });
    }
    const status = action === 'approve' ? 'approved' : 'denied';
    const [row] = await sql`UPDATE workflow_access
        SET status = ${status}, decided_by = ${admin.userId}, decided_at = now()
        WHERE user_id = ${userId} AND status = 'pending'
        RETURNING user_id`;
    if (!row) return NextResponse.json({ error: 'Request not found or already decided.' }, { status: 404 });
    // A denial also detaches: a user must never keep generating through a
    // workflow an admin just refused them.
    if (status === 'denied') {
        await sql`UPDATE users SET workflow_id = NULL WHERE id = ${userId}`;
    }
    await writeAudit(sql, {
        actorId: admin.userId, actorEmail: admin.email, action: `workflow.access_${status}`,
        targetType: 'user', targetId: userId,
    });
    return NextResponse.json({ ok: true, status });
}
