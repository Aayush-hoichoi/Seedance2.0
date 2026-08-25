// The ledger's filter predicates, in one place.
//
// Two routes need exactly these: the list (which rows to show, and how many)
// and the facets (which values the dropdowns offer). They are written once and
// shared, so a dropdown can never offer a value the list would not match — the
// two are the same WHERE clause or they are nothing.
//
// Free of next/server so it is directly testable, the same split
// lib/gateway/enqueue.mjs and lib/ledger/feed.mjs use.

// Filterable columns, keyed by the query parameter that selects them; the
// value is the workbook column the filter reads.
//
// Both workbooks spell these three identically, so one map serves the master
// and the video view alike — see MASTER_COLUMNS / VIDEO_COLUMNS in
// lib/ledger/columns.mjs, where 'User Name', 'User Email', 'Project' and
// 'Model' appear at the same names in both.
//
// The user filter keys on 'User Email', not 'User Name'. Two people can share
// a display name; nobody shares an address. The dropdown still SHOWS the name
// (see the facets route) — it just does not match on it.
export const FILTER_COLUMNS = {
    model: 'Model',
    user: 'User Email',
    project: 'Project',
};

export const FILTER_NAMES = Object.keys(FILTER_COLUMNS);

/** Pull the filter values out of a URLSearchParams, dropping blanks. */
export function readFilters(params) {
    const filters = {};
    for (const name of FILTER_NAMES) {
        const value = (params.get(name) || '').trim();
        if (value) filters[name] = value;
    }
    return filters;
}

/**
 * Build the predicate list for a filtered ledger query.
 *
 * `bind` registers a value and returns its placeholder ($1, $2, …), so the
 * caller owns the parameter array and can keep appending to it — the list
 * route still has a media, a limit and an offset to add after these.
 */
export function ledgerPredicates({ q = null, filters = {} } = {}, bind) {
    const predicates = [];

    if (q) predicates.push(`cells::text ILIKE '%' || ${bind(q)} || '%'`);

    for (const name of FILTER_NAMES) {
        const value = filters[name];
        if (!value) continue;
        // Exact match, not ILIKE. These values come from a dropdown built out
        // of the values that actually occur, so a substring match could only
        // ever be wrong: picking "Seedance 1.0" would silently also return
        // every "Seedance 1.0 Pro" row.
        predicates.push(`cells->>'${FILTER_COLUMNS[name]}' = ${bind(value)}`);
    }

    return predicates;
}

export function whereClause(predicates) {
    return predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
}

/**
 * The whole WHERE assembly for one ledger listing, ready for both the count
 * and the page.
 *
 * Returns `where` (the filters alone), `rowsWhere` (filters AND the media
 * scope), `mediaTest` on its own, the bound `values`, and the live `bind` so
 * the caller can append its LIMIT and OFFSET in the right positions.
 *
 * The media scope is kept separable on purpose: the media tab badges count
 * rows that match the search and filters but NOT the current tab — that is the
 * number that tells an admin whether the other tab is worth clicking.
 */
export function ledgerQuery({ q = null, filters = {}, media = null } = {}) {
    const values = [];
    const bind = (value) => { values.push(value); return `$${values.length}`; };

    const where = whereClause(ledgerPredicates({ q, filters }, bind));

    const mediaParam = bind(media);
    const mediaTest = `(${mediaParam}::text IS NULL OR media = ${mediaParam})`;

    return {
        where,
        mediaTest,
        rowsWhere: where ? `${where} AND ${mediaTest}` : `WHERE ${mediaTest}`,
        values,
        bind,
    };
}

/**
 * Does one shaped row match these filters?
 *
 * The in-memory twin of ledgerPredicates, for the export. The export builds its
 * rows from generation_ledger and never reads ledger_rows — it must stay
 * correct on a database where the backfill has never run — so it cannot reuse
 * the SQL. It filters the shaped cells instead, which are the very values the
 * console displays and filters on, so the two agree by construction.
 *
 * `media` is not handled here: the workbook builders already scope it.
 */
export function rowMatches(cells, { q = null, filters = {} } = {}) {
    for (const name of FILTER_NAMES) {
        const value = filters[name];
        if (value && cells[FILTER_COLUMNS[name]] !== value) return false;
    }

    if (q) {
        // The SQL side is `cells::text ILIKE '%q%'` — the whole row rendered as
        // JSON, column names included. Rendered the same way here so that a
        // search matching on screen matches in the file. (The two texts differ
        // in whitespace only: Postgres puts a space after each colon.)
        if (!JSON.stringify(cells).toLowerCase().includes(q.toLowerCase())) return false;
    }

    return true;
}

/**
 * The distinct values one filter column offers, with a row count each.
 *
 * `name` is a FILTER_COLUMNS key, so the column names interpolated below are
 * from this module and never from a request. `labelColumn` is the column to
 * display instead of the matched value — the user filter matches an email and
 * shows a name.
 */
export function facetQuery(name, { media = null, labelColumn = null } = {}) {
    const column = FILTER_COLUMNS[name];
    if (!column) throw new Error(`Not a filterable column: ${name}`);

    const values = [];
    // A row with no value for this column offers nothing to pick, so it is not
    // an option — but note the shaped rows spell an unknown value
    // '(not recorded)' rather than leaving it empty, and that IS a real option:
    // it is how the pre-gateway era is selected.
    let where = `WHERE coalesce(cells->>'${column}', '') <> ''`;
    if (media) {
        values.push(media);
        where += ` AND media = $${values.length}`;
    }

    const label = labelColumn
        ? `max(cells->>'${labelColumn}')`
        : `cells->>'${column}'`;

    return {
        text: `SELECT cells->>'${column}' AS value, ${label} AS label, count(*)::int AS count
               FROM ledger_rows
               ${where}
               GROUP BY cells->>'${column}'
               ORDER BY count(*) DESC, 1 ASC`,
        values,
    };
}
