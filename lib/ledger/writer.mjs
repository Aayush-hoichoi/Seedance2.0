// Drains ledger_sync into the SharePoint workbooks.
//
// This is the half that is allowed to fail. Everything it needs is already
// committed in ledger_rows, so a locked file, a throttled tenant or a
// Microsoft outage costs nothing but freshness — no generation is slowed, no
// data is lost, and the backlog drains in order whenever the workbook frees
// up. That is the entire reason the staging table exists.
//
// Writes are strictly sequential, per Microsoft's own guidance: concurrent
// writes to one workbook produce throttling, timeouts and merge conflicts
// rather than throughput. At ~180 generations/day — one every eight minutes —
// there is nothing to gain from parallelism anyway.

import { toValuesRow } from './columns.mjs';
import { configuredTargets } from './targets.mjs';
import { pendingRows, markClean, noteError } from './queue.mjs';
import {
    createSession, closeSession, readKeyColumn, addRow, patchRow, GraphError,
} from '../graph/workbook.mjs';

// Bounded by BOTH a row count and a wall-clock budget.
//
// The clock is the one that matters. drainLedger runs inside sweep(), which
// runs inside the SSE loop (app/api/events/route.js) — so time spent here is
// time live events are NOT reaching connected browsers. Graph writes are
// sequential and take a few hundred milliseconds each, so a row cap alone
// bounds the work but not the latency: 200 rows could be a minute and a half.
// The deadline caps the latency directly, whatever each row costs.
//
// Stopping early is free. Undrained rows stay dirty and go out on the next
// tick, and the sheet converges either way.
const MAX_ROWS_PER_DRAIN = 100;
const DRAIN_BUDGET_MS = Number(process.env.LEDGER_DRAIN_BUDGET_MS) || 10_000;

// Row indexes drift whenever anyone inserts or deletes rows in Excel by hand,
// so a stored index is a hint, not a fact. Re-reading the key column once per
// drain costs one request and makes the writer correct under manual edits —
// without it, a single inserted row would send every subsequent update to the
// wrong line.
async function indexFor(target, sessionId) {
    try {
        return await readKeyColumn(target, sessionId);
    } catch (err) {
        if (err instanceof GraphError && err.isLocked) throw err;
        // A workbook with no table yet, or an unreadable column: fall back to
        // stored indexes rather than refusing to write anything at all.
        return null;
    }
}

async function drainTarget(sql, target, limit, deadline) {
    const rows = await pendingRows(sql, target.id, limit);
    if (!rows.length) return { target: target.id, pending: 0, written: 0, locked: false };

    let sessionId = null;
    let written = 0;
    let locked = false;
    let throttled = false;
    let outOfTime = false;

    try {
        sessionId = await createSession(target);
        const liveIndex = await indexFor(target, sessionId);

        for (const row of rows) {
            // Checked between rows, never mid-row: a half-written row would be
            // marked clean without having landed.
            if (Date.now() > deadline) { outOfTime = true; break; }
            const values = toValuesRow(row.cells);
            const known = liveIndex ? liveIndex.get(row.row_key) : row.row_index;
            try {
                if (known === undefined || known === null) {
                    const index = await addRow(target, sessionId, values);
                    await markClean(sql, row.row_key, target.id, index);
                } else {
                    await patchRow(target, sessionId, known, values);
                    await markClean(sql, row.row_key, target.id, known);
                }
                written += 1;
            } catch (err) {
                if (err instanceof GraphError && err.isLocked) { locked = true; break; }
                if (err instanceof GraphError && err.isThrottled) { throttled = true; break; }
                // A single bad row must not block the queue behind it. Record
                // the reason and move on; it stays dirty and is retried.
                await noteError(sql, row.row_key, target.id, err.message);
            }
        }
    } catch (err) {
        if (err instanceof GraphError && err.isLocked) locked = true;
        else if (err instanceof GraphError && err.isThrottled) throttled = true;
        else console.error(`[ledger] ${target.id}: ${err.message}`);
    } finally {
        await closeSession(target, sessionId);
    }

    if (locked) console.warn(`[ledger] ${target.id} (${target.label}) is open in Excel — ${rows.length - written} row(s) queued`);
    if (throttled) console.warn(`[ledger] ${target.id} throttled by Graph — ${rows.length - written} row(s) queued`);
    return { target: target.id, pending: rows.length, written, locked, throttled, outOfTime };
}

/**
 * Drain every configured workbook. One locked file never stalls the other:
 * each target is attempted independently, which is exactly why sync state is
 * keyed per (row, target).
 *
 * Returns a per-target summary. Never throws — the caller (sweep) must not be
 * able to fail because a spreadsheet was busy.
 */
export async function drainLedger(sql, { limit = MAX_ROWS_PER_DRAIN, budgetMs = DRAIN_BUDGET_MS } = {}) {
    const targets = configuredTargets();
    if (!targets.length) return { skipped: 'no workbook configured', results: [] };

    // The budget is per target, not shared: a slow or locked master workbook
    // must not eat the video workbook's turn. Each gets its own clock.
    const results = [];
    for (const target of targets) {
        const deadline = Date.now() + budgetMs;
        results.push(await drainTarget(sql, target, limit, deadline).catch((err) => {
            console.error(`[ledger] ${target.id} drain failed — ${err.message}`);
            return { target: target.id, pending: 0, written: 0, error: err.message };
        }));
    }
    return { results };
}
