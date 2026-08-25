import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db/neon.js';
import { authorize, acknowledge } from '../../../../lib/ledger/feed.mjs';

// Confirm which rows a flow actually wrote into the workbook.
//
// The flow acknowledges the rows it wrote, NOT everything it was served. If it
// dies half way through — throttled, the file was locked, the run timed out —
// the unacknowledged rows stay dirty and come back on the next poll. That is
// the same at-least-once property the server-side Graph writer has, and it is
// why the sheet converges instead of quietly losing rows.
//
//   POST /api/ledger/ack
//   Authorization: Bearer <CRON_SECRET>
//   { "target": "master", "rowKeys": ["job:5231", "job:5232"] }

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
    const denied = authorize(request.headers.get('authorization'));
    if (denied) return NextResponse.json(denied.body, { status: denied.status });

    const sql = await getDb();
    if (!sql) return NextResponse.json({ error: 'DB not configured' }, { status: 503 });

    const body = await request.json().catch(() => null);
    const result = await acknowledge(sql, body);
    return NextResponse.json(result.body, { status: result.status });
}
