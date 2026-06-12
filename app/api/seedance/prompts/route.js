import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db/neon.js';

// Prompt-pair store (Neon Postgres), keyed by ModelArk task id.
// POST { taskId, userPrompt, generatedPrompt, style }  → upsert
// GET  ?taskIds=a,b,c                                  → { items: [...] }

export const runtime = 'nodejs';
export const maxDuration = 15;

const MAX_IDS = 100;
const MAX_TEXT = 20000;

function bad(message, status = 400) {
    return NextResponse.json({ error: message }, { status });
}

export async function POST(request) {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return bad('Invalid JSON body.');

    const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
    if (!taskId || taskId.length > 200) return bad('taskId is required.');

    const clip = (v) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : null);
    const userPrompt = clip(body.userPrompt);
    const generatedPrompt = clip(body.generatedPrompt);
    const style = typeof body.style === 'string' ? body.style.slice(0, 50) : null;

    let sql;
    try {
        sql = await getDb();
    } catch {
        return bad('Could not reach the prompts database.', 502);
    }
    if (!sql) return bad('DATABASE_URL is not configured — add it to .env.local (and the Vercel env).', 503);

    try {
        await sql`INSERT INTO seedance_prompts (task_id, style, user_prompt, generated_prompt)
            VALUES (${taskId}, ${style}, ${userPrompt}, ${generatedPrompt})
            ON CONFLICT (task_id) DO UPDATE SET
                style = EXCLUDED.style,
                user_prompt = EXCLUDED.user_prompt,
                generated_prompt = EXCLUDED.generated_prompt`;
    } catch {
        return bad('Failed to save the prompt record.', 502);
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
        const rows = await sql`SELECT task_id, style, user_prompt, generated_prompt
            FROM seedance_prompts WHERE task_id = ANY(${ids})`;
        return NextResponse.json({ items: rows });
    } catch {
        return bad('Failed to load prompt records.', 502);
    }
}
