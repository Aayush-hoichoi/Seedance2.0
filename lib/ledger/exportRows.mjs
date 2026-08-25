// Which rows an export contains, shaped and session-numbered.
//
// Free of next/server so the ordering below is directly testable — the same
// split lib/ledger/feed.mjs uses, and here it matters more than anywhere else
// in the ledger.

import { computeSessions } from './sessions.mjs';
import { shapeLedgerRow } from './shape.mjs';
import { rowMatches } from './filters.mjs';

/**
 * Shape every row against the WHOLE history, then drop the ones the view
 * excludes.
 *
 * THE ORDER IS LOAD-BEARING, and it is the reason this function exists rather
 * than a `.filter()` at the call site. "Try #", "Tries in Session",
 * "Successes in Session", "Accepted Output", "Acceptance Basis" and
 * "Confidence" are all computed across a row's siblings. Filter first and every
 * one of them is computed against whatever survived the filter:
 *
 *   • filtering to one model renumbers that model's tries as though the other
 *     models in the session had never been run — "Try 3 of 7" becomes
 *     "Try 1 of 2";
 *   • a row correctly marked Superseded can be promoted to the accepted output
 *     of the session, because the later success that beat it was filtered out.
 *
 * A filtered export narrows which rows you see. It must never change what any
 * row says. Sessions are computed over `rows` in full, and only then is the
 * selection taken.
 *
 * `rows` is mutated in place (computeSessions and the `cells` assignment), which
 * is what the unfiltered export already relied on.
 */
export function selectExportRows(rows, { q = null, filters = {}, media = null } = {}) {
    computeSessions(rows);
    for (const row of rows) row.cells = shapeLedgerRow(row);

    const narrowed = Boolean(q || media || Object.keys(filters).length);
    if (!narrowed) return rows;

    return rows.filter((row) => (
        (!media || row.media === media) && rowMatches(row.cells, { q, filters })
    ));
}
