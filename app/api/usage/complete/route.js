import { NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { finalizeUsage } from '../../../../lib/access/db.js';
import { getDb } from '../../../../lib/db/neon.js';
import { settleSuccess, settleFailure } from '../../../../lib/gateway/processor.mjs';

// Settle the gateway job that wraps this ModelArk task: settlement/failure
// billing event, job terminal state, SSE event, budget threshold alerts.
async function settleGatewayJob(taskId, task, status) {
    try {
        const sql = await getDb();
        if (!sql) return;
        const [job] = await sql`SELECT * FROM jobs WHERE provider_task_id = ${taskId} AND status IN ('queued', 'running')`;
        if (!job) return; // pre-migration task or already settled
        if (status === 'succeeded') {
            // Kind from the catalog, not the client-shaped request_body —
            // fall back to it only for jobs that predate model_version_id.
            const [version] = job.model_version_id
                ? await sql`SELECT kind FROM model_versions WHERE id = ${job.model_version_id}`
                : [];
            await settleSuccess(sql, job, {
                route: { provider_id: 'byteplus', mode: 'interactive' },
                apiKeyId: null,
                result: { video_url: task?.content?.video_url || null },
                usage: task?.usage || null,
                kind: version?.kind ?? job.request_body?.options?.kind,
            });
        } else {
            await settleFailure(sql, job, { status: 400, message: task?.error?.message || status });
        }
    } catch { /* settlement is retried on the next poll; never block the client */ }
}

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
        await settleGatewayJob(taskId, task, 'succeeded');
        return NextResponse.json({ ok: true, status: 'succeeded', costUsd: result?.costUsd ?? null });
    }
    if (status === 'failed' || status === 'cancelled' || status === 'canceled' || status === 'expired') {
        await finalizeUsage(taskId, user.userId, { status: 'failed', completionTokens: null });
        await settleGatewayJob(taskId, task, 'failed');
        return NextResponse.json({ ok: true, status: 'failed' });
    }
    return NextResponse.json({ ok: true, status: status || 'pending' }); // not terminal — no-op
}
