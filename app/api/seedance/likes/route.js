import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db/neon.js';
import { getUser } from '../../../../lib/auth/user.js';
import { recordGenerationEvent } from '../../../../lib/access/db.js';

// Like store (Neon Postgres) — a thin write path over the seedance_prompts
// table's `liked` column, keyed by ModelArk task id.
// POST { taskId, liked } → upsert the like mark (reads back via the prompts GET).

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
    if (typeof body.liked !== 'boolean') return bad('liked must be a boolean.');
    const liked = body.liked;

    let sql;
    try {
        sql = await getDb();
    } catch {
        return bad('Could not reach the likes database.', 502);
    }
    if (!sql) return bad('DATABASE_URL is not configured — add it to .env.local (and the Vercel env).', 503);

    try {
        // Upsert: a like can land before any prompt record exists for the task,
        // so insert a bare row and only ever touch the `liked` column on conflict.
        await sql`INSERT INTO seedance_prompts (task_id, liked)
            VALUES (${taskId}, ${liked})
            ON CONFLICT (task_id) DO UPDATE SET liked = EXCLUDED.liked`;
    } catch {
        return bad('Failed to save the like.', 502);
    }
    // Log the per-user event for the dataset signal (best-effort; the boolean
    // above is the current-state source of truth for the gallery heart).
    const user = await getUser().catch(() => null);
    await recordGenerationEvent(sql, { taskId, userId: user?.userId ?? null, eventType: liked ? 'like' : 'unlike' });
    return NextResponse.json({ ok: true, taskId, liked });
}
