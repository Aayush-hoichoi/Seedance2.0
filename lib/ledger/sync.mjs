// The ledger tick: generation_ledger → ledger_rows → ledger_sync('dirty').
//
// This is the Postgres half, and it is the half that is not allowed to fail.
// It never touches Microsoft Graph, never opens a workbook, and never blocks
// on anything outside the database — so a locked file, a throttled tenant or a
// Microsoft outage cannot reach it. The Excel half (lib/ledger/writer.mjs)
// drains ledger_sync separately and is allowed to fail all day.
//
// Two properties make it self-healing:
//   • the watermark advances only after rows are committed, so a crash mid-tick
//     just redoes the range;
//   • every write is an upsert on an invariant key, so redoing a range is a
//     no-op rather than a duplicate.
// Together: the worker can be down for three hours and the next tick catches
// up in one pass, with no gap and no double rows.

import { computeSessions, affectedWindow } from './sessions.mjs';
import { shapeLedgerRow } from './shape.mjs';
import { ledgerTargets } from './targets.mjs';

const WATERMARK_KEY = 'ledger.watermark';
// A cap so one tick after a long outage cannot build an unbounded window.
// Anything left over is picked up by the next tick a minute later.
//
// Kept modest on purpose: sweep() is called from inside the SSE loop
// (app/api/events/route.js), so a slow tick delays live events reaching every
// connected browser. Steady state is single digits — this ceiling only matters
// for catch-up after downtime, and catching up a minute later is free.
const MAX_CHANGED_PER_TICK = 200;

// The cursor is (updated_at, row_key), not a bare timestamp.
//
// Timestamps tie — routinely. A migration stamps many rows at once, a batch
// settles together, two jobs finish in the same millisecond. With a bare
// `updated_at > cursor` cursor and a per-tick limit, a block of rows sharing
// one instant is fatal: the tick reads its limit, advances the cursor past
// that instant, and every remaining row at the same timestamp is skipped
// forever. Paging on the composite orders within the tie and resumes inside
// it, so a tied block is walked through rather than jumped over.
//
// …and the cursor travels as Postgres text, never through a JS Date. Postgres
// keeps microseconds; a Date keeps milliseconds. Round-tripping the cursor
// through one truncates it — `new Date('…14.015788Z').toISOString()` is
// `…14.015Z`, which sorts BEFORE the row it was supposed to consume. Every
// tick then re-reads its own boundary row, and once `limit` rows share a
// single millisecond the tick re-reads that same block forever without
// advancing: exactly the tie-block stall the composite cursor exists to
// prevent, reintroduced by the round trip. `at` stays a Date for callers that
// reason about the time; `atText` is what the comparison actually uses.
export async function readWatermark(sql) {
    const [row] = await sql`SELECT value FROM gateway_state WHERE key = ${WATERMARK_KEY}`;
    const at = row?.value?.at;
    return {
        at: at ? new Date(at) : new Date(0),
        atText: at || '1970-01-01T00:00:00.000000Z',
        key: row?.value?.key ?? '',
    };
}

export async function writeWatermark(sql, { at, key = '' }) {
    // A string is stored verbatim so its microseconds survive. A Date — the
    // backfill's "now" boundary — has none to lose and is serialised normally.
    const stamp = typeof at === 'string' ? at : new Date(at).toISOString();
    const value = JSON.stringify({ at: stamp, key });
    await sql`INSERT INTO gateway_state (key, value, updated_at)
        VALUES (${WATERMARK_KEY}, ${value}, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

// Rows past the cursor, in cursor order, so the last row read IS the new
// cursor — no scanning for a maximum, and no chance of advancing past a row
// that was not actually staged.
//
// `cursor_at` is the row's own updated_at rendered to microsecond ISO text, so
// the next tick resumes on the value Postgres compared, not on a Date's
// rounding of it.
async function changedSince(sql, cursor, limit) {
    return sql`SELECT *,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM generation_ledger
        WHERE (updated_at, row_key) > (${cursor.atText}::timestamptz, ${cursor.key}::text)
        ORDER BY updated_at ASC, row_key ASC
        LIMIT ${limit}`;
}

// Widen a set of changed rows to every row that could share a session with
// them. Without this the acceptance columns are computed against a partial
// window: a new success would be marked YES while the previous success in the
// same session kept its now-stale YES, leaving two accepted outputs in one
// session. See lib/ledger/sessions.mjs for the full argument.
async function widenToSessions(sql, changed) {
    const windows = affectedWindow(changed);
    if (!windows.length) return changed;

    const byKey = new Map(changed.map((r) => [r.row_key, r]));
    for (const w of windows) {
        const rows = await sql`SELECT * FROM generation_ledger
            WHERE user_id = ${w.userId}
              AND project_id = ${w.projectId}
              AND media = ${w.media}
              AND submitted_at BETWEEN ${w.from.toISOString()} AND ${w.to.toISOString()}`;
        for (const row of rows) if (!byKey.has(row.row_key)) byKey.set(row.row_key, row);
    }
    return [...byKey.values()];
}

// Rows per statement. Neon speaks HTTP, so each statement is a round trip —
// writing a row at a time would cost three trips per row and turn a catch-up
// tick into a minute of latency inside the SSE loop that calls sweep().
// Batching makes a whole tick two statements instead of hundreds.
const UPSERT_CHUNK = 200;

// Upsert a batch of shaped rows. Returns the keys that were actually new or
// actually changed — ON CONFLICT … WHERE cells IS DISTINCT FROM means an
// unchanged row is not updated and not returned, which is what stops a
// session-wide recompute from rewriting twenty untouched rows into Excel every
// time one generation moves.
//
// Safe to batch because the window is deduplicated by row_key upstream:
// Postgres rejects a statement whose ON CONFLICT would touch one row twice.
//
// Exported for scripts/ledger-backfill.mjs, which stages the same rows by the
// same rules — sharing this is what keeps a backfilled row and a ticked row
// byte-identical instead of merely similar.
export async function upsertLedgerRows(sql, rows) {
    const changedKeys = [];
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        const chunk = rows.slice(i, i + UPSERT_CHUNK);
        const params = [];
        const tuples = chunk.map((row) => {
            const base = params.length;
            params.push(
                row.row_key, row.era, row.media, row.status ?? null,
                row.submitted_at, row.session_id ?? null,
                JSON.stringify(shapeLedgerRow(row)), row.updated_at,
            );
            return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},`
                + `$${base + 5},$${base + 6},$${base + 7}::jsonb,$${base + 8},now())`;
        });
        const returned = await sql.query(
            `INSERT INTO ledger_rows
                (row_key, era, media, status, submitted_at, session_id, cells, source_at, updated_at)
             VALUES ${tuples.join(',')}
             ON CONFLICT (row_key) DO UPDATE
                SET era = EXCLUDED.era, media = EXCLUDED.media, status = EXCLUDED.status,
                    submitted_at = EXCLUDED.submitted_at, session_id = EXCLUDED.session_id,
                    cells = EXCLUDED.cells, source_at = EXCLUDED.source_at, updated_at = now()
                WHERE ledger_rows.cells IS DISTINCT FROM EXCLUDED.cells
             RETURNING row_key`,
            params,
        );
        for (const r of returned) changedKeys.push(r.row_key);
    }
    return changedKeys;
}

// Queue the changed rows for every workbook that wants them.
//
// Written as a separate statement rather than one transaction with the upsert:
// a row that lands without its dirty flag is corrected by the next tick (its
// source_at will still differ from the view), and a dirty flag without its row
// is harmless — the writer inner-joins and simply skips it.
async function queueForTargets(sql, rows, changedKeys, targets) {
    if (!changedKeys.length) return;
    const changed = new Set(changedKeys);
    const pairs = [];
    for (const row of rows) {
        if (!changed.has(row.row_key)) continue;
        for (const t of targets) if (t.filter(row)) pairs.push([row.row_key, t.id]);
    }
    for (let i = 0; i < pairs.length; i += UPSERT_CHUNK) {
        const chunk = pairs.slice(i, i + UPSERT_CHUNK);
        const params = [];
        const tuples = chunk.map(([key, targetId]) => {
            const base = params.length;
            params.push(key, targetId);
            return `($${base + 1},$${base + 2},'dirty',now())`;
        });
        await sql.query(
            `INSERT INTO ledger_sync (row_key, target_id, sync_state, updated_at)
             VALUES ${tuples.join(',')}
             ON CONFLICT (row_key, target_id) DO UPDATE
                SET sync_state = 'dirty', updated_at = now()`,
            params,
        );
    }
}

/**
 * Run one tick. Returns a summary; never throws for ordinary conditions.
 *
 * `sql` is a ready neon client. Callers own the schedule — sweep() runs this
 * at most once a minute across all serverless instances via its gateway_state
 * lock, which is the same cron substitute the rest of the gateway uses.
 */
export async function runLedgerTick(sql, { limit = MAX_CHANGED_PER_TICK } = {}) {
    const cursor = await readWatermark(sql);
    const changed = await changedSince(sql, cursor, limit);
    if (!changed.length) return { changed: 0, written: 0, watermark: cursor };

    // Ordered by the cursor, so the last row read is exactly how far we got.
    const last = changed[changed.length - 1];
    const highWater = { at: last.cursor_at, key: last.row_key };

    const window = await widenToSessions(sql, changed);
    computeSessions(window);

    const targets = ledgerTargets();
    const changedKeys = await upsertLedgerRows(sql, window);
    await queueForTargets(sql, window, changedKeys, targets);

    // Only now. A crash above leaves the watermark where it was, the same range
    // is re-read next tick, and every upsert is idempotent.
    await writeWatermark(sql, highWater);
    return {
        changed: changed.length,
        expanded: window.length,
        written: changedKeys.length,
        watermark: highWater,
    };
}
