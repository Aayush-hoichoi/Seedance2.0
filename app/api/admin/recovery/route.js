import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../lib/gateway/authz.js';
import { recoverGeneration, restoreBinned } from '../../../../lib/seedance/recovery.mjs';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request) {
    const auth = await gatewayContext();
    if (!auth.ok) return auth.response;
    if (!auth.ctx.isPlatformAdmin) return NextResponse.json({ error: 'Admin access required.' }, { status: 403 });
    const { sql, user } = auth.ctx;
    const body = await request.json().catch(() => null);
    if (!body || !['start', 'scan'].includes(body.action)
        || (body.action === 'scan' && (!Number.isSafeInteger(body.before) || body.before < 1))) {
        return NextResponse.json({ error: 'Invalid recovery request.' }, { status: 400 });
    }
    try {
        if (body.action === 'start') {
            const restored = await restoreBinned(sql, user);
            const [summary] = await sql.query(`SELECT count(*)::int AS total, coalesce(max(id),0)::int + 1 AS before
                FROM jobs WHERE status = 'succeeded'`);
            return NextResponse.json({ restored, ...summary });
        }
        // Small descending batches avoid request timeouts and keep newly arriving jobs
        // outside this run. Repeating a batch is safe: existing files are never replaced.
        const jobs = await sql.query(`SELECT id, provider_task_id, result,
            coalesce(request_body->>'category', 'video') AS category
            FROM jobs WHERE status = 'succeeded' AND id < $1 ORDER BY id DESC LIMIT 3`, [body.before]);
        const outcomes = [];
        for (const job of jobs) {
            const outcome = await recoverGeneration(job);
            const changed = JSON.stringify(outcome.result) !== JSON.stringify(job.result || {});
            const details = { recoveredFiles: outcome.recovered, problems: outcome.problems };
            if (changed) {
                const rows = await sql.query(`WITH updated AS (
                    UPDATE jobs SET result = $2::jsonb WHERE id = $1 AND result IS NOT DISTINCT FROM $3::jsonb RETURNING id
                ) INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, after)
                    SELECT $4, $5, 'generation.recover', 'job', id::text, $6::jsonb FROM updated RETURNING id`,
                [job.id, JSON.stringify(outcome.result), JSON.stringify(job.result), user.userId, user.email, JSON.stringify(details)]);
                if (!rows.length) outcome.problems.push('The record changed during recovery; run recovery again.');
            } else if (outcome.recovered || outcome.problems.length) {
                await sql.query(`INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, after)
                    VALUES ($1,$2,'generation.recover','job',$3,$4::jsonb)`,
                [user.userId, user.email, String(job.id), JSON.stringify(details)]);
            }
            outcomes.push({ id: job.id, recovered: outcome.recovered, problems: outcome.problems });
        }
        return NextResponse.json({ outcomes, before: jobs.at(-1)?.id ?? null, done: jobs.length < 3 });
    } catch (error) {
        console.error('[recovery]', error.message);
        return NextResponse.json({ error: 'Recovery stopped. Completed restores are saved; you can retry.' }, { status: 500 });
    }
}
