// The ledger feed's logic, free of next/server so it is directly testable —
// the same split lib/gateway/enqueue.mjs uses. The route files under
// app/api/ledger/ are thin wrappers that turn these plain results into
// NextResponse objects.
//
// These endpoints sit OUTSIDE the Clerk gate (middleware.js exempts
// /api/ledger) because a Power Automate flow cannot carry a Clerk session. The
// bearer check below is therefore the only thing between the prompt and cost
// history and the open internet, and it fails closed.

import { pendingRows, pendingCount, markManyClean, targetById } from './queue.mjs';
import { LEDGER_COLUMNS } from './columns.mjs';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_KEYS = 1000;

/**
 * @returns null when authorised, or { status, body } describing the refusal.
 */
export function authorize(authorizationHeader) {
    const secret = process.env.CRON_SECRET;
    // An unset secret must LOCK the route, never open it. This path has no
    // other gate, so "not configured" and "allow everyone" must never be the
    // same state.
    if (!secret) {
        return { status: 401, body: { error: 'Unauthorized (CRON_SECRET is not set on the server)' } };
    }
    if (authorizationHeader !== `Bearer ${secret}`) {
        return { status: 401, body: { error: 'Unauthorized' } };
    }
    return null;
}

export async function pendingFeed(sql, { target: targetId = 'master', limit } = {}) {
    const target = targetById(targetId);
    if (!target) return { status: 400, body: { error: `Unknown target "${targetId}"` } };

    const size = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
    const rows = await pendingRows(sql, targetId, size);
    const queued = await pendingCount(sql, targetId);

    return {
        status: 200,
        body: {
            target: targetId,
            workbook: target.label,
            columns: LEDGER_COLUMNS,
            count: rows.length,
            // What is still queued AFTER this batch, so a flow can loop until
            // zero rather than guessing whether one pass was enough.
            remaining: Math.max(0, queued - rows.length),
            // Keyed by the workbook's own column names, so the Excel
            // connector's field mapping is one-to-one and the flow needs no
            // transform step. _rowKey is what the flow sends back to /ack.
            rows: rows.map((r) => ({ ...r.cells, _rowKey: r.row_key })),
        },
    };
}

export async function acknowledge(sql, body) {
    if (!body || typeof body !== 'object') {
        return { status: 400, body: { error: 'Expected a JSON body' } };
    }
    const targetId = body.target || 'master';
    if (!targetById(targetId)) {
        return { status: 400, body: { error: `Unknown target "${targetId}"` } };
    }

    // A single key is accepted too: inside an "Apply to each" loop it is far
    // simpler to acknowledge one row than to build an array variable.
    const raw = Array.isArray(body.rowKeys) ? body.rowKeys
        : typeof body.rowKey === 'string' ? [body.rowKey]
            : [];
    const rowKeys = [...new Set(raw.filter((k) => typeof k === 'string' && k))].slice(0, MAX_KEYS);
    if (!rowKeys.length) return { status: 400, body: { error: 'Provide rowKey or rowKeys' } };

    const acknowledged = await markManyClean(sql, targetId, rowKeys);
    return { status: 200, body: { target: targetId, requested: rowKeys.length, acknowledged } };
}
