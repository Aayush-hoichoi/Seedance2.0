import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../lib/gateway/authz.js';
import { workflowAccessFor, writeAudit } from '../../../../lib/gateway/db.js';
import { styleSummary } from '../../../../lib/gateway/projectStyle.mjs';
import { draftWorkflowStyle } from '../../../../lib/gateway/workflowRefresh.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60; // the style draft is one enhancer-model call

const MAX_CUSTOM_PER_USER = 10;

// Create a custom workflow from a plain-words description. Private to its
// creator; same gate as using workflows (one approved access request), same
// style schema, and the nightly refresh improves it from liked generations
// exactly like the official ones.
export async function POST(request) {
    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { sql, user, isPlatformAdmin } = auth.ctx;
    if (!isPlatformAdmin && await workflowAccessFor(sql, user.userId) !== 'approved') {
        return NextResponse.json({ error: 'Workflows need admin approval first — request access from the picker.' }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const description = typeof body?.description === 'string' ? body.description.trim() : '';
    const examplePrompt = typeof body?.examplePrompt === 'string' ? body.examplePrompt.trim().slice(0, 5000) : null;
    if (!name) return NextResponse.json({ error: 'Give the workflow a name.' }, { status: 400 });
    if (description.length < 10) return NextResponse.json({ error: 'Describe the look in at least a sentence.' }, { status: 400 });
    if (description.length > 2000) return NextResponse.json({ error: 'Keep the description under 2000 characters.' }, { status: 400 });

    const [{ n }] = await sql`SELECT count(*)::int AS n FROM workflows
        WHERE created_by = ${user.userId} AND deleted_at IS NULL`;
    if (n >= MAX_CUSTOM_PER_USER) {
        return NextResponse.json({ error: `You already have ${MAX_CUSTOM_PER_USER} workflows — delete one first.` }, { status: 409 });
    }

    const style = await draftWorkflowStyle({ name, description, examplePrompt });
    const [row] = await sql`INSERT INTO workflows (name, description, style, created_by)
        VALUES (${name}, ${description.slice(0, 200)}, ${JSON.stringify(style)}::jsonb, ${user.userId})
        RETURNING id, name, description, created_by`;
    await writeAudit(sql, {
        actorId: user.userId, actorEmail: user.email, action: 'workflow.created',
        targetType: 'workflow', targetId: row.id, after: style,
    });
    return NextResponse.json({
        item: { id: row.id, name: row.name, description: row.description, style: styleSummary(style), mine: true },
    });
}

// Delete your own custom workflow (platform admins may delete any). Soft
// delete, and anyone attached to it is detached — the gateway would ignore a
// deleted workflow anyway, this just keeps their picker truthful.
export async function DELETE(request) {
    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { sql, user, isPlatformAdmin } = auth.ctx;
    const body = await request.json().catch(() => null);
    const id = Number(body?.workflowId);
    if (!id) return NextResponse.json({ error: 'workflowId is required.' }, { status: 400 });
    const [row] = isPlatformAdmin
        ? await sql`UPDATE workflows SET deleted_at = now() WHERE id = ${id} AND deleted_at IS NULL RETURNING id, created_by`
        : await sql`UPDATE workflows SET deleted_at = now()
            WHERE id = ${id} AND deleted_at IS NULL AND created_by = ${user.userId} RETURNING id, created_by`;
    if (!row) return NextResponse.json({ error: 'Workflow not found, or it is not yours to delete.' }, { status: 404 });
    await sql`UPDATE users SET workflow_id = NULL WHERE workflow_id = ${id}`;
    await writeAudit(sql, {
        actorId: user.userId, actorEmail: user.email, action: 'workflow.deleted',
        targetType: 'workflow', targetId: id,
    });
    return NextResponse.json({ ok: true });
}
