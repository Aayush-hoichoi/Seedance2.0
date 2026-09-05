import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../../lib/gateway/authz.js';
import { writeAudit } from '../../../../../lib/gateway/db.js';
import { masterWorkbook, videoWorkbook } from '../../../../../lib/ledger/workbooks.mjs';
import { buildXlsx } from '../../../../../lib/ledger/xlsxWrite.mjs';
import { readFilters, readRange } from '../../../../../lib/ledger/filters.mjs';
import { selectExportRows } from '../../../../../lib/ledger/exportRows.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Download either workbook, reproduced exactly, generated on the spot.
//
//   GET /api/admin/ledger/export?workbook=master   → logline-generations-master
//   GET /api/admin/ledger/export?workbook=video    → video-generations-all-time
//
// Built from generation_ledger rather than ledger_rows, and re-running
// computeSessions over the whole history in one pass. Two reasons:
//
//   • Sessions are a whole-history computation. Reading pre-computed rows would
//     be faster, but it would inherit whatever window the incremental tick last
//     recomputed — an export must not depend on the sync having caught up.
//   • It means an export is correct on a database where the backfill has never
//     been run, which is the state most installs start in.
//
// 9,000 rows through the session pass is a few milliseconds of pure JS; the
// single query dominates. Correctness is the right thing to buy here.
//
// ── Exporting a filtered view ───────────────────────────────────────────────
//
//   GET /api/admin/ledger/export?workbook=master&model=seedance-2.0&user=a@b.tv
//
// The same q / model / user / project / media the console list takes, so the
// file holds exactly the rows on screen. Unfiltered, this is still the whole
// workbook — the property the ledger exists to protect — and the console keeps
// a separate button for each.
//
// THE ORDER BELOW IS LORE-BEARING: sessions are computed over the whole
// history and only then are rows dropped. Filtering first would recompute
// "Try #", "Tries in Session", "Successes in Session" and "Accepted Output"
// against whatever survived the filter — so filtering to one model would
// renumber that model's tries as though the others had never been run, and
// could promote a superseded row to the accepted one. A filtered export must
// narrow which rows you see, never change what any row says.

const WORKBOOKS = {
    master: { file: 'logline-generations-master', label: 'master' },
    video: { file: 'video-generations-all-time', label: 'video' },
};

const MEDIA_VALUES = new Set(['Image', 'Video']);

export async function GET(request) {
    const auth = await gatewayContext({ permission: 'ledger.view' });
    if (!auth.ok) return auth.response;
    const { sql, user } = auth.ctx;

    const params = new URL(request.url).searchParams;
    const spec = WORKBOOKS[params.get('workbook')] ?? WORKBOOKS.master;
    const isVideo = spec.label === 'video';

    const q = (params.get('q') || '').trim() || null;
    const filters = readFilters(params);
    const range = readRange(params);
    const requestedMedia = params.get('media');
    const media = isVideo
        ? 'Video'
        : (MEDIA_VALUES.has(requestedMedia) ? requestedMedia : null);
    const narrowed = Boolean(q || media || Object.keys(filters).length || range.from || range.to);

    // Oldest-first: both workbooks read as a history, and the session pass
    // needs chronological order anyway.
    const rows = await sql`SELECT * FROM generation_ledger ORDER BY submitted_at ASC NULLS FIRST`;

    // Sessions over the whole history, then the selection — see the note above.
    const selected = selectExportRows(rows, { q, filters, range, media });

    const bucket = process.env.TOS_BUCKET?.trim() || 'seedance-studio-assets';
    const region = process.env.TOS_REGION?.trim() || 'ap-southeast-1';

    // The roll-up sheets (By User / Model / Project / Date) are rebuilt from
    // whatever was selected, so a filtered file totals the view it contains
    // rather than a history it does not.
    const sheets = isVideo
        ? videoWorkbook(selected.filter((r) => r.media === 'Video'), { bucket, region })
        : masterWorkbook(selected, { snapshot: new Date().toISOString() });

    const workbook = buildXlsx({ sheets });

    await writeAudit(sql, {
        actorId: user.userId,
        actorEmail: user.email,
        action: 'ledger.export',
        targetType: 'ledger',
        targetId: spec.label,
        // Which rows left the building, and why they were the ones. A filtered
        // export is still an export of every prompt and cost it contains.
        after: {
            workbook: spec.label,
            rows: sheets[0].rows.length,
            sheets: sheets.length,
            ...(narrowed ? { filtered: { q, media, ...filters, ...range } } : {}),
        },
        ip: request.headers.get('x-forwarded-for'),
    }).catch(() => { /* an audit failure must not deny the operator their file */ });

    // A filtered file must not land in Downloads under the same name as the
    // real workbook — that is how a partial view gets mailed on as the ledger.
    const filename = narrowed ? `${spec.file}-view` : spec.file;

    return new NextResponse(workbook, {
        headers: {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="${filename}.xlsx"`,
            'Content-Length': String(workbook.length),
            'Cache-Control': 'no-store',
        },
    });
}
