import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../lib/gateway/authz.js';
import { MASTER_COLUMNS, VIDEO_COLUMNS, projectRow } from '../../../../lib/ledger/columns.mjs';
import { ACCEPTANCE_BASIS } from '../../../../lib/ledger/sessions.mjs';
import { readFilters, ledgerQuery } from '../../../../lib/ledger/filters.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The generation ledger for the console, in whichever workbook's exact shape
// the caller asks for — the same 41 or 45 columns, in the same order, with the
// same wording as the downloadable file. The table on screen and the file on
// disk are the same thing, which is the whole point.
//
// Admin-only via `ledger.view`. These rows carry every user's prompts, costs
// and email, so this lives under /api/admin (behind the Clerk gate) rather
// than /api/ledger, which middleware.js exempts for machine callers.
//
//   GET /api/admin/ledger?workbook=video&media=Video&limit=200&offset=0&q=text
//   GET /api/admin/ledger?model=seedance-2.0&user=a@b.tv&project=Hooliganism
//
// `q` is free text across every column; model / user / project are exact
// matches on one column each, and the values come from
// /api/admin/ledger/facets so a dropdown can only offer what exists.
//
// Paged server-side: 9,133 rows x 45 columns is roughly 20 MB of JSON, which
// is not something to hand a browser. Export returns everything.

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function GET(request) {
    const auth = await gatewayContext({ permission: 'ledger.view' });
    if (!auth.ok) return auth.response;
    const { sql } = auth.ctx;

    const params = new URL(request.url).searchParams;
    const workbook = params.get('workbook') === 'video' ? 'video' : 'master';
    const columns = workbook === 'video' ? VIDEO_COLUMNS : MASTER_COLUMNS;

    // The video workbook is video-only by definition; the master holds both,
    // so it accepts a media filter.
    const requestedMedia = params.get('media');
    const media = workbook === 'video'
        ? 'Video'
        : (requestedMedia === 'Image' || requestedMedia === 'Video' ? requestedMedia : null);

    const q = (params.get('q') || '').trim() || null;
    const filters = readFilters(params);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(params.get('limit')) || DEFAULT_LIMIT));
    const offset = Math.max(0, Number(params.get('offset')) || 0);

    // One parameter array and one predicate list, shared by the count and the
    // page. Building them separately is how a table and its own row count
    // start disagreeing about what is being filtered.
    const { where, mediaTest, rowsWhere, values, bind } = ledgerQuery({ q, filters, media });

    // Snapshot before the LIMIT/OFFSET are bound: Postgres rejects a statement
    // handed more parameters than it references.
    const countValues = [...values];
    const [counts] = await sql.query(
        `SELECT count(*) FILTER (WHERE ${mediaTest})::int             AS total,
                count(*) FILTER (WHERE media = 'Image')::int AS images,
                count(*) FILTER (WHERE media = 'Video')::int AS videos
         FROM ledger_rows
         ${where}`,
        countValues,
    );

    const rows = await sql.query(
        `SELECT cells FROM ledger_rows
         ${rowsWhere}
         ORDER BY submitted_at DESC NULLS LAST, row_key DESC
         LIMIT ${bind(limit)} OFFSET ${bind(offset)}`,
        values,
    );

    const projected = rows.map((r) => {
        const cells = projectRow(r.cells, columns);
        // The one wording the two workbooks disagree on.
        if (workbook === 'master' && cells['Acceptance Basis'] === ACCEPTANCE_BASIS.NO_SUCCESS) {
            cells['Acceptance Basis'] = ACCEPTANCE_BASIS.NO_SUCCESS_MASTER;
        }
        return { ...cells, _rowKey: r.cells['Row Key'] };
    });

    return NextResponse.json({
        workbook,
        columns,
        counts: counts ?? { total: 0, images: 0, videos: 0 },
        // Echoed back so the client can render "filtered by …" from the
        // response it actually got, rather than from what it hoped it sent.
        filters,
        limit,
        offset,
        rows: projected,
    });
}
