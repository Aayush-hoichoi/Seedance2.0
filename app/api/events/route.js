import { gatewayContext } from '../../../lib/gateway/authz.js';
import { sweep } from '../../../lib/gateway/sweep.mjs';

// SSE stream (design §6): tails the Neon events outbox every 2s, scoped to
// the caller's audience (workspace-wide + their projects + personal). Supports
// Last-Event-ID resume; each connection lives ≤ ~4.5 min and the browser's
// EventSource reconnects seamlessly. Every tick runs the guarded sweep() —
// this is what replaces per-minute cron on the Vercel free plan.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const TICK_MS = 2_000;
const LIFETIME_MS = 270_000; // reconnect before the platform kills us

export async function GET(request) {
    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { sql, user, role } = auth.ctx;

    const memberships = await sql`SELECT project_id FROM project_memberships WHERE user_id = ${user.userId}`;
    const projectIds = memberships.map((m) => m.project_id);
    const isAdmin = role === 'admin';

    let cursor = Number(request.headers.get('last-event-id')) || null;
    if (cursor == null) {
        const [row] = await sql`SELECT COALESCE(MAX(id), 0) AS max FROM events`;
        cursor = Number(row?.max ?? 0);
    }

    const encoder = new TextEncoder();
    const started = Date.now();
    let closed = false;
    request.signal?.addEventListener('abort', () => { closed = true; });

    const stream = new ReadableStream({
        async start(controller) {
            controller.enqueue(encoder.encode(`retry: 3000\n\n`));
            while (!closed && Date.now() - started < LIFETIME_MS) {
                try {
                    const rows = await sql.query(
                        `SELECT * FROM events
                         WHERE id > $1
                           AND ($2 OR project_id IS NULL OR project_id = ANY($3::int[]) OR user_id = $4)
                         ORDER BY id ASC LIMIT 100`,
                        [cursor, isAdmin, projectIds, user.userId],
                    );
                    for (const row of rows) {
                        cursor = row.id;
                        controller.enqueue(encoder.encode(
                            `id: ${row.id}\nevent: ${row.type}\ndata: ${JSON.stringify({ ...row.payload, projectId: row.project_id, userId: row.user_id, at: row.created_at })}\n\n`,
                        ));
                    }
                    if (!rows.length) controller.enqueue(encoder.encode(`: keepalive\n\n`));
                    await sweep().catch(() => {});
                } catch {
                    break; // DB hiccup: close; the client reconnects with Last-Event-ID
                }
                await new Promise((r) => setTimeout(r, TICK_MS));
            }
            try { controller.close(); } catch { /* already closed */ }
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
        },
    });
}
