import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db/neon.js';
import { authorize, pendingFeed } from '../../../../lib/ledger/feed.mjs';

// The rows a workbook is missing, as flat JSON.
//
// This is the no-admin delivery route: a Power Automate flow signs in as a
// person, polls this endpoint and writes the rows with the Excel Online
// connector. That path needs no Entra app registration, no Sites.Selected and
// no admin consent — which is why it exists alongside the server-side Graph
// writer in lib/ledger/writer.mjs. Both drain the same ledger_sync queue, so
// either can run, or both during a switch-over.
//
//   GET /api/ledger/pending?target=master&limit=100
//   Authorization: Bearer <CRON_SECRET>
//
// All logic lives in lib/ledger/feed.mjs so it is testable without next/server.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
    const denied = authorize(request.headers.get('authorization'));
    if (denied) return NextResponse.json(denied.body, { status: denied.status });

    const sql = await getDb();
    if (!sql) return NextResponse.json({ error: 'DB not configured' }, { status: 503 });

    const params = request.nextUrl.searchParams;
    const result = await pendingFeed(sql, {
        target: params.get('target') || 'master',
        limit: params.get('limit'),
    });
    return NextResponse.json(result.body, { status: result.status });
}
