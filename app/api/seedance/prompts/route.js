import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db/neon.js';
import { getUser } from '../../../../lib/auth/user.js';
import { getTaskOwner } from '../../../../lib/access/db.js';

// Prompt-pair store (Neon Postgres), keyed by ModelArk task id.
// POST { taskId, userPrompt, generatedPrompt, style, refs }  → upsert
// GET  ?taskIds=a,b,c                                        → { items: [...] }

export const runtime = 'nodejs';
export const maxDuration = 15;

const MAX_IDS = 100;

function bad(message, status = 400) {
    return NextResponse.json({ error: message }, { status });
}

// Sanitize the reference-asset list: only the fields the history UI needs,
// length-capped, never data: URLs (asset:// and https:// links only).
const MAX_REFS = 20;
const REF_KINDS = new Set(['image', 'video', 'audio']);
function sanitizeRefs(refs) {
    if (!Array.isArray(refs)) return null;
    const clean = (v, max) => (typeof v === 'string' && v.length <= max && !v.startsWith('data:') ? v : null);
    const out = refs.slice(0, MAX_REFS).flatMap((r) => {
        if (!r || typeof r !== 'object' || !REF_KINDS.has(r.kind)) return [];
        return [{
            kind: r.kind,
            role: clean(r.role, 40),
            url: clean(r.url, 2048),
            previewUrl: clean(r.previewUrl, 4096),
            name: clean(r.name, 200),
            assetId: clean(r.assetId, 200),
            // TOS object key ("uploads/…") — lets any browser re-presign the
            // reference URL forever via GET /api/byteplus/archive?key=.
            tosKey: clean(r.tosKey, 200),
        }];
    });
    return out.length ? out : null;
}

export async function POST(request) {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return bad('Invalid JSON body.');

    const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
    if (!taskId || taskId.length > 200) return bad('taskId is required.');

    // Unclipped — Postgres `text` holds prompts of any length.
    const asText = (v) => (typeof v === 'string' ? v : null);
    const userPrompt = asText(body.userPrompt);
    const generatedPrompt = asText(body.generatedPrompt);
    const style = typeof body.style === 'string' ? body.style.slice(0, 50) : null;
    const refs = sanitizeRefs(body.refs);
    const projectId = Number.isInteger(body.projectId) ? body.projectId : null;

    let sql;
    try {
        sql = await getDb();
    } catch {
        return bad('Could not reach the prompts database.', 502);
    }
    if (!sql) return bad('DATABASE_URL is not configured — add it to .env.local (and the Vercel env).', 503);

    try {
        // COALESCE keeps refs written at creation when a later backfill
        // (which has no asset info) upserts the same task with refs = null.
        await sql`INSERT INTO seedance_prompts (task_id, style, user_prompt, generated_prompt, refs, project_id)
            VALUES (${taskId}, ${style}, ${userPrompt}, ${generatedPrompt}, ${refs ? JSON.stringify(refs) : null}::jsonb, ${projectId})
            ON CONFLICT (task_id) DO UPDATE SET
                style = EXCLUDED.style,
                user_prompt = EXCLUDED.user_prompt,
                generated_prompt = EXCLUDED.generated_prompt,
                refs = COALESCE(EXCLUDED.refs, seedance_prompts.refs),
                project_id = COALESCE(EXCLUDED.project_id, seedance_prompts.project_id)`;
    } catch {
        return bad('Failed to save the prompt record.', 502);
    }
    return NextResponse.json({ ok: true, taskId });
}

// DELETE ?taskId=xxx → permanently drop a generation's record, so a deleted
// history card cannot be resurrected by the reload server-merge. Owner-only
// (or admin): everyone may view/reuse a generation, only its creator kills it.
export async function DELETE(request) {
    const { searchParams } = new URL(request.url);
    const taskId = (searchParams.get('taskId') || '').trim();
    if (!taskId || taskId.length > 200) return bad('taskId is required.');

    const user = await getUser();
    if (!user) return bad('Unauthorized', 401);
    const owner = await getTaskOwner(taskId).catch(() => null);
    if (owner && owner !== user.userId && user.role !== 'admin') {
        return bad('Only the creator can delete this generation.', 403);
    }

    let sql;
    try {
        sql = await getDb();
    } catch {
        return bad('Could not reach the prompts database.', 502);
    }
    if (!sql) return bad('DATABASE_URL is not configured — add it to .env.local (and the Vercel env).', 503);

    try {
        await sql`DELETE FROM seedance_prompts WHERE task_id = ${taskId}`;
    } catch {
        return bad('Failed to delete the prompt record.', 502);
    }
    return NextResponse.json({ ok: true, taskId });
}

export async function GET(request) {
    const { searchParams } = new URL(request.url);
    const ids = (searchParams.get('taskIds') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, MAX_IDS);
    if (!ids.length) return NextResponse.json({ items: [] });

    let sql;
    try {
        sql = await getDb();
    } catch {
        return bad('Could not reach the prompts database.', 502);
    }
    // No DB configured → empty result, so the UI degrades to local-only prompts.
    if (!sql) return NextResponse.json({ items: [] });

    try {
        const rows = await sql`SELECT task_id, style, user_prompt, generated_prompt, refs, liked, deleted
            FROM seedance_prompts WHERE task_id = ANY(${ids})`;
        return NextResponse.json({ items: rows });
    } catch {
        return bad('Failed to load prompt records.', 502);
    }
}
