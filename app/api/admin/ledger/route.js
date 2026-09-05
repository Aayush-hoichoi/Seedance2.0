import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../lib/gateway/authz.js';
import { MASTER_COLUMNS, VIDEO_COLUMNS, projectRow } from '../../../../lib/ledger/columns.mjs';
import { ACCEPTANCE_BASIS } from '../../../../lib/ledger/sessions.mjs';
import { readFilters, readRange, ledgerQuery, readSort, orderBy } from '../../../../lib/ledger/filters.mjs';

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
//   GET /api/admin/ledger?sort=oldest
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
    const range = readRange(params); // from/to, inclusive YYYY-MM-DD (IST)
    const sort = readSort(params);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(params.get('limit')) || DEFAULT_LIMIT));
    const offset = Math.max(0, Number(params.get('offset')) || 0);

    // One parameter array and one predicate list, shared by the count and the
    // page. Building them separately is how a table and its own row count
    // start disagreeing about what is being filtered.
    const { where, mediaTest, rowsWhere, values, bind } = ledgerQuery({ q, filters, range, media });

    // Snapshot before the LIMIT/OFFSET are bound: Postgres rejects a statement
    // handed more parameters than it references.
    const countValues = [...values];
    const [counts] = await sql.query(
        `SELECT count(*) FILTER (WHERE ${mediaTest})::int             AS total,
                count(*) FILTER (WHERE media = 'Image')::int AS images,
                count(*) FILTER (WHERE media = 'Video')::int AS videos,
                count(*) FILTER (WHERE ${mediaTest} AND status = 'succeeded')::int AS succeeded,
                count(*) FILTER (WHERE ${mediaTest} AND status = 'failed')::int AS failed,
                count(*) FILTER (WHERE ${mediaTest} AND status = 'timed_out')::int AS timed_out,
                count(*) FILTER (WHERE ${mediaTest} AND status = 'rejected')::int AS rejected,
                count(*) FILTER (WHERE ${mediaTest} AND status = 'cancelled')::int AS cancelled,
                count(*) FILTER (WHERE ${mediaTest} AND status = 'queued')::int AS queued,
                count(*) FILTER (WHERE ${mediaTest} AND status = 'running')::int AS running
         FROM ledger_rows
         ${where}`,
        countValues,
    );

    // Per-day rollup over the SAME filtered view (rowsWhere covers the media
    // tab too), grouped by the 'Date (IST)' cell so the chart's days are the
    // days the Date column shows. Cost cells are money numbers or '' — NULLIF
    // keeps the blanks out of the sum.
    const days = await sql.query(
        `SELECT cells->>'Date (IST)' AS key,
                count(*)::int AS total,
                count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
                count(*) FILTER (WHERE status IN ('failed', 'timed_out', 'rejected', 'cancelled'))::int AS failed,
                count(*) FILTER (WHERE status IN ('queued', 'running'))::int AS active,
                COALESCE(SUM(NULLIF(cells->>'Cost (USD)', '')::numeric), 0)::float8 AS cost_usd
         FROM ledger_rows
         ${rowsWhere}
         GROUP BY 1 ORDER BY 1`,
        countValues,
    );

    // orderBy() resolves through a fixed map, so nothing from the request is
    // ever interpolated here.
    const rows = await sql.query(
        `SELECT cells FROM ledger_rows
         ${rowsWhere}
         ORDER BY ${orderBy(sort)}
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
        counts: {
            ...(counts ?? { total: 0, images: 0, videos: 0 }),
            // One aggregate SELECT already powers the visible total and media
            // badges. Status counts extend that same response so Analytics can
            // accurately cover every filtered row without loading all pages.
            statuses: {
                succeeded: counts?.succeeded ?? 0,
                failed: counts?.failed ?? 0,
                timed_out: counts?.timed_out ?? 0,
                rejected: counts?.rejected ?? 0,
                cancelled: counts?.cancelled ?? 0,
                queued: counts?.queued ?? 0,
                running: counts?.running ?? 0,
            },
        },
        // One row per IST day in the filtered view, chronological. A row with
        // no date (blank cell) has no day to land on and is dropped.
        days: days.filter((d) => d.key),
        // Echoed back so the client can render "filtered by …" from the
        // response it actually got, rather than from what it hoped it sent.
        filters,
        range,
        sort,
        limit,
        offset,
        rows: projected,
    });
}
