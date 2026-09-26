import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../lib/gateway/authz.js';
import { userWorkflowId, workflowAccessFor, listWorkflowsFor } from '../../../lib/gateway/db.js';
import { styleSummary } from '../../../lib/gateway/projectStyle.mjs';
import { notifyTeamsWorkflowRequested } from '../../../lib/notify/teamsWorkflow.mjs';

export const runtime = 'nodejs';

// Workspace workflows: named, reusable styles a user can attach in the studio,
// regardless of project. GATED once per user: a single admin-approved request
// unlocks every workflow (platform admins bypass). Returns only what the
// picker needs; the brief prose stays server-side (injected at generation
// time).
export async function GET() {
    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { sql, user, isPlatformAdmin } = auth.ctx;
    const rows = await listWorkflowsFor(sql, user.userId);
    return NextResponse.json({
        items: rows
            .map((w) => ({
                id: w.id, name: w.name, description: w.description, style: styleSummary(w.style),
                mine: w.created_by === user.userId, // own customs are deletable in the picker
            }))
            .filter((w) => w.style), // a workflow with no usable looks can't be attached
        access: isPlatformAdmin ? 'approved' : await workflowAccessFor(sql, user.userId),
        attachedId: await userWorkflowId(sql, user.userId),
    });
}

// Ask for workflow access (one request covers all workflows). Idempotent: an
// existing pending/approved row stands; a denied one flips back to pending so
// the user can re-ask.
export async function POST(request) {
    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { sql, user } = auth.ctx;
    const body = await request.json().catch(() => null);
    const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : null;
    const [before] = await sql`SELECT status FROM workflow_access WHERE user_id = ${user.userId}`;
    const [row] = await sql`INSERT INTO workflow_access (user_id, note)
        VALUES (${user.userId}, ${note})
        ON CONFLICT (user_id) DO UPDATE SET
            status = CASE WHEN workflow_access.status = 'denied' THEN 'pending' ELSE workflow_access.status END
        RETURNING status, note`;
    // Teams card to every admin — only when the request NEWLY became pending,
    // so a double-click never re-pings anyone. Best-effort: the request row is
    // already committed, and the console Requests hub is the source of truth.
    if (row.status === 'pending' && before?.status !== 'pending') {
        await notifyTeamsWorkflowRequested({
            request: { userId: user.userId, userEmail: user.email, note: row.note },
            sql,
        }).catch(() => {});
    }
    return NextResponse.json({ access: row.status });
}

// Attach ({ workflowId: n }) or detach ({ workflowId: null }). Stored on the
// user, not the browser, so it follows them across devices and every surface
// (studio, MCP, raw API) applies it. Attaching requires approved access.
export async function PATCH(request) {
    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { sql, user, isPlatformAdmin } = auth.ctx;
    const body = await request.json().catch(() => null);
    const id = body?.workflowId == null ? null : Number(body.workflowId);
    if (id !== null) {
        // Officials are attachable by anyone (with access); a custom only by
        // its creator — another user's private workflow is invisible here.
        const [found] = await sql`SELECT id FROM workflows WHERE id = ${id} AND deleted_at IS NULL
            AND (created_by IS NULL OR created_by = ${user.userId})`;
        if (!found) return NextResponse.json({ error: 'Unknown workflow.' }, { status: 404 });
        if (!isPlatformAdmin && await workflowAccessFor(sql, user.userId) !== 'approved') {
            return NextResponse.json({ error: 'Workflows need admin approval first — request access from the picker.' }, { status: 403 });
        }
    }
    await sql`UPDATE users SET workflow_id = ${id} WHERE id = ${user.userId}`;
    return NextResponse.json({ attachedId: id });
}
