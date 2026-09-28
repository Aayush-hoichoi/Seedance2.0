import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../lib/gateway/authz.js';
import { userWorkflowIds, workflowAccessFor, listWorkflowsFor } from '../../../lib/gateway/db.js';
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
                media: w.media || 'all', // 'all' | 'video' | 'image'
                mine: w.created_by === user.userId, // own customs are editable/deletable in the picker
                visibility: w.created_by ? w.visibility : 'public', // officials are inherently shared
                creator: w.created_by && w.created_by !== user.userId ? (w.creator_email || null) : null,
                // The owner's full original description, for Edit's prefill
                // (workflows.description is truncated for the card).
                sourceDescription: w.created_by === user.userId ? (w.style?.sourceDescription ?? w.description ?? '') : undefined,
            }))
            .filter((w) => w.style), // a workflow with no usable looks can't be attached
        access: isPlatformAdmin ? 'approved' : await workflowAccessFor(sql, user.userId),
        attached: await userWorkflowIds(sql, user.userId), // { video, image }
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

// Attach ({ workflowId: n }) or detach ({ workflowId: null, media? }).
// Stored on the user, not the browser, so it follows them across devices and
// every surface (studio, MCP, raw API) applies it. Two slots: an image-only
// workflow lands in the image slot, everything else in the main slot; an
// 'all' workflow clears the image slot because it now governs both.
export async function PATCH(request) {
    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { sql, user, isPlatformAdmin } = auth.ctx;
    const body = await request.json().catch(() => null);
    const id = body?.workflowId == null ? null : Number(body.workflowId);
    if (id !== null) {
        // Officials and PUBLIC customs are attachable by anyone (with access);
        // a private custom only by its creator.
        const [found] = await sql`SELECT id, media FROM workflows WHERE id = ${id} AND deleted_at IS NULL
            AND (created_by IS NULL OR created_by = ${user.userId} OR visibility = 'public')`;
        if (!found) return NextResponse.json({ error: 'Unknown workflow.' }, { status: 404 });
        if (!isPlatformAdmin && await workflowAccessFor(sql, user.userId) !== 'approved') {
            return NextResponse.json({ error: 'Workflows need admin approval first — request access from the picker.' }, { status: 403 });
        }
        if (found.media === 'image') {
            await sql`UPDATE users SET image_workflow_id = ${id} WHERE id = ${user.userId}`;
        } else if (found.media === 'video') {
            await sql`UPDATE users SET workflow_id = ${id} WHERE id = ${user.userId}`;
        } else {
            await sql`UPDATE users SET workflow_id = ${id}, image_workflow_id = NULL WHERE id = ${user.userId}`;
        }
    } else {
        const media = ['video', 'image'].includes(body?.media) ? body.media : 'all';
        if (media === 'image') await sql`UPDATE users SET image_workflow_id = NULL WHERE id = ${user.userId}`;
        else if (media === 'video') await sql`UPDATE users SET workflow_id = NULL WHERE id = ${user.userId}`;
        else await sql`UPDATE users SET workflow_id = NULL, image_workflow_id = NULL WHERE id = ${user.userId}`;
    }
    return NextResponse.json({ attached: await userWorkflowIds(sql, user.userId) });
}
