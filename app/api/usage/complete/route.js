import { NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { finalizeUsage } from '../../../../lib/access/db.js';

export const runtime = 'nodejs';
const ARK_BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3';

// Finalize a usage row once its task reaches a terminal state. Re-fetches the
// task from ModelArk (server key) so completion_tokens is authoritative — the
// client is never trusted for token counts. Idempotent; no-op for non-terminal,
// unknown, or foreign tasks.
export async function POST(request) {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ ok: false }, { status: 200 }); }
    const taskId = body?.taskId;
    if (!taskId) return NextResponse.json({ ok: false }, { status: 200 });

    const key = process.env.ARK_API_KEY;
    if (!key) return NextResponse.json({ ok: false }, { status: 200 });

    let task;
    try {
        const r = await fetch(`${ARK_BASE}/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
            headers: { Authorization: `Bearer ${key}` },
        });
        task = await r.json();
    } catch {
        return NextResponse.json({ ok: false }, { status: 200 });
    }

    const status = (task?.status || '').toLowerCase();
    if (status === 'succeeded') {
        const tokens = task?.usage?.completion_tokens ?? null;
        const result = await finalizeUsage(taskId, user.userId, { status: 'succeeded', completionTokens: tokens });
        return NextResponse.json({ ok: true, status: 'succeeded', costUsd: result?.costUsd ?? null });
    }
    if (status === 'failed' || status === 'cancelled' || status === 'canceled' || status === 'expired') {
        await finalizeUsage(taskId, user.userId, { status: 'failed', completionTokens: null });
        return NextResponse.json({ ok: true, status: 'failed' });
    }
    return NextResponse.json({ ok: true, status: status || 'pending' }); // not terminal — no-op
}
