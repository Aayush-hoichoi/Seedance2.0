import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db/neon.js';
import { getUser } from '../../../../lib/auth/user.js';
import { getTaskOwner } from '../../../../lib/access/db.js';

// Bin store (Neon Postgres) — a thin write path over the seedance_prompts
// `deleted` column, keyed by ModelArk task id. Binning (soft-delete) has to be
// server-side, or another browser's reload re-merges the task from ModelArk's
// list and shows it again. POST { taskId, deleted } (read back via prompts GET).
//
// Everyone can SEE and REUSE every generation (community gallery), but only
// its creator (or an admin) can bin it. Tasks from before per-user tracking
// have no recorded owner and stay open to everyone.

export const runtime = 'nodejs';
export const maxDuration = 15;

function bad(message, status = 400) {
    return NextResponse.json({ error: message }, { status });
}

export async function POST(request) {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return bad('Invalid JSON body.');

    const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
    if (!taskId || taskId.length > 200) return bad('taskId is required.');
    if (typeof body.deleted !== 'boolean') return bad('deleted must be a boolean.');
    const deleted = body.deleted;

    const user = await getUser();
    if (!user) return bad('Unauthorized', 401);
    const owner = await getTaskOwner(taskId).catch(() => null);
    if (owner && owner !== user.userId && user.role !== 'admin') {
        return bad('Only the creator can remove this generation.', 403);
    }

    let sql;
    try {
        sql = await getDb();
    } catch {
        return bad('Could not reach the bin database.', 502);
    }
    if (!sql) return bad('DATABASE_URL is not configured — add it to .env.local (and the Vercel env).', 503);

    try {
        // Upsert: a bin action can land before any prompt record exists for the
        // task, so insert a bare row and only ever touch the `deleted` column.
        await sql`INSERT INTO seedance_prompts (task_id, deleted)
            VALUES (${taskId}, ${deleted})
            ON CONFLICT (task_id) DO UPDATE SET deleted = EXCLUDED.deleted`;
    } catch {
        return bad('Failed to save the bin state.', 502);
    }
    return NextResponse.json({ ok: true, taskId, deleted });
}
