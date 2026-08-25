// The pending-rows queue, shared by both delivery routes.
//
// Two things can drain ledger_sync into a workbook:
//   • lib/ledger/writer.mjs — Microsoft Graph, server-side, needs Sites.Selected
//   • app/api/ledger/*      — an HTTP feed a Power Automate flow pulls, which
//                             runs as a person and needs no admin consent
//
// They share this module so the two can never disagree about what is pending,
// what "done" means, or which rows belong to which workbook. Switching between
// them — or running both during a migration — is safe because the queue is the
// same rows in the same table either way.

import { ledgerTargets } from './targets.mjs';

export function targetById(id) {
    return ledgerTargets().find((t) => t.id === id) || null;
}

// Oldest first: a workbook filling in submission order reads naturally, and a
// partial drain leaves a sensible prefix rather than a scatter.
export async function pendingRows(sql, targetId, limit) {
    return sql`SELECT s.row_key, s.row_index, r.cells
        FROM ledger_sync s
        JOIN ledger_rows r ON r.row_key = s.row_key
        WHERE s.target_id = ${targetId} AND s.sync_state = 'dirty'
        ORDER BY r.submitted_at ASC, s.row_key ASC
        LIMIT ${limit}`;
}

export async function pendingCount(sql, targetId) {
    const [row] = await sql`SELECT count(*)::int AS n FROM ledger_sync
        WHERE target_id = ${targetId} AND sync_state = 'dirty'`;
    return row?.n ?? 0;
}

export async function markClean(sql, rowKey, targetId, rowIndex = null) {
    await sql`UPDATE ledger_sync
        SET sync_state = 'clean', row_index = ${rowIndex}, last_error = NULL, updated_at = now()
        WHERE row_key = ${rowKey} AND target_id = ${targetId}`;
}

// Acknowledge a batch. Deliberately NOT "mark everything we last served":
// the caller acknowledges the rows it actually wrote, so a flow that dies
// half way through leaves the rest dirty and simply retries them.
export async function markManyClean(sql, targetId, rowKeys) {
    if (!rowKeys.length) return 0;
    const rows = await sql`UPDATE ledger_sync
        SET sync_state = 'clean', last_error = NULL, updated_at = now()
        WHERE target_id = ${targetId} AND row_key = ANY(${rowKeys})
        RETURNING row_key`;
    return rows.length;
}

export async function noteError(sql, rowKey, targetId, message) {
    await sql`UPDATE ledger_sync
        SET last_error = ${String(message).slice(0, 500)}, updated_at = now()
        WHERE row_key = ${rowKey} AND target_id = ${targetId}`;
}
