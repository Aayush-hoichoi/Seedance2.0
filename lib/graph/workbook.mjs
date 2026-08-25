// Microsoft Graph Excel client, scoped to exactly what the ledger needs:
// open a workbook session, add rows, patch rows, close.
//
// Auth reuses the Teams bot's Entra app registration (lib/teams/bot.mjs) with
// a different scope — same tenant, same client id, same secret, so there is
// one registration to consent to and one secret to rotate.
//
// Three Graph behaviours drive the shape of this module:
//
//  • 423 resourceLocked. Write operations fail while the workbook is open in
//    Excel desktop or in a co-authoring session, and Graph exposes NO way to
//    check the lock before trying. So the only correct strategy is: attempt,
//    recognise 423, stop cleanly, leave the work queued, try again later.
//
//  • Do not parallelise. Microsoft is explicit that concurrent writes to one
//    workbook cause throttling, timeouts and merge conflicts rather than
//    speed. Every call site here is sequential and deliberately so.
//
//  • Sessions expire after ~5 minutes idle (persistent) and opening a large
//    workbook can exceed the request timeout, hence persistChanges plus the
//    long-running-operation pattern on createSession.

import { clientCredentialsToken } from '../teams/bot.mjs';

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const GRAPH_TIMEOUT_MS = Number(process.env.GRAPH_TIMEOUT_MS) || 60_000;
const LRO_POLL_MS = 5_000;
const LRO_MAX_WAIT_MS = 240_000; // Graph's own guidance: never poll beyond 4 minutes

const cachedGraphToken = { value: '', expiresAt: 0 };

export const graphToken = () => clientCredentialsToken(GRAPH_SCOPE, cachedGraphToken);

export class GraphError extends Error {
    constructor(message, { status, code, retryAfterMs = 0 } = {}) {
        super(message);
        this.name = 'GraphError';
        this.status = status;
        this.code = code;
        this.retryAfterMs = retryAfterMs;
    }

    // The workbook is open in Excel or in a co-authoring session. Not an error
    // in any actionable sense — it means "come back later".
    get isLocked() {
        return this.status === 423 || this.code === 'resourceLocked';
    }

    get isThrottled() {
        return this.status === 429 || this.status === 503;
    }
}

function retryAfterMs(res) {
    const header = res.headers.get('retry-after');
    if (!header) return 0;
    const seconds = Number(header);
    return Number.isFinite(seconds) ? seconds * 1000 : 0;
}

async function graphFetch(path, { method = 'GET', body, headers = {}, sessionId } = {}) {
    const token = await graphToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GRAPH_TIMEOUT_MS);
    let res;
    try {
        res = await fetch(path.startsWith('http') ? path : `${GRAPH_ROOT}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...(sessionId ? { 'workbook-session-id': sessionId } : {}),
                ...headers,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (err) {
        if (err?.name === 'AbortError') throw new GraphError(`graph ${method} timed out after ${GRAPH_TIMEOUT_MS}ms`, {});
        throw err;
    } finally {
        clearTimeout(timer);
    }

    if (res.status === 204) return { status: res.status, body: null, res };
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
        // Graph nests the useful code two or three levels down; the outer one
        // is usually just "internalServerError".
        const err = payload?.error || {};
        const inner = err.innerError?.innerError || err.innerError || {};
        throw new GraphError(err.message || `graph ${method} ${res.status}`, {
            status: res.status,
            code: inner.code || err.code,
            retryAfterMs: retryAfterMs(res),
        });
    }
    return { status: res.status, body: payload, res };
}

const itemRoot = ({ driveId, itemId }) => `/drives/${driveId}/items/${itemId}/workbook`;

/**
 * Open a persistent workbook session.
 *
 * persistChanges: true is required — a non-persistent session discards writes.
 * `Prefer: respond-async` handles the case Graph documents explicitly: opening
 * a large workbook can take longer than the request timeout, and both target
 * files are already ~4.5 MB and growing.
 */
export async function createSession(target) {
    const { status, body, res } = await graphFetch(`${itemRoot(target)}/createSession`, {
        method: 'POST',
        body: { persistChanges: true },
        headers: { Prefer: 'respond-async' },
    });

    if (status !== 202) return body?.id || null;

    const location = res.headers.get('location');
    if (!location) throw new GraphError('graph createSession returned 202 with no Location', { status });

    const deadline = Date.now() + LRO_MAX_WAIT_MS;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, LRO_POLL_MS));
        const { body: op } = await graphFetch(location);
        if (op?.status === 'succeeded') {
            const { body: info } = await graphFetch(op.resourceLocation);
            return info?.id || null;
        }
        if (op?.status === 'failed') {
            const inner = op.error?.innerError?.innerError || op.error?.innerError || {};
            throw new GraphError(op.error?.message || 'workbook could not be opened', { code: inner.code });
        }
    }
    throw new GraphError('graph createSession did not complete within 4 minutes', {});
}

export async function closeSession(target, sessionId) {
    if (!sessionId) return;
    // Best-effort: an unclosed session simply expires after ~5 idle minutes,
    // so a failure here must never mask the outcome of the writes themselves.
    await graphFetch(`${itemRoot(target)}/closeSession`, { method: 'POST', body: {}, sessionId })
        .catch(() => {});
}

// Read the key column so the writer can rebuild its row_key → row index map.
// Index is 0-based and relative to the table's data body, which is what
// rows/itemAt(index=…) addresses.
export async function readKeyColumn(target, sessionId, { keyColumn = 1 } = {}) {
    const path = `${itemRoot(target)}/tables/${encodeURIComponent(target.tableName)}`
        + `/columns/itemAt(index=${keyColumn - 1})/values`;
    const { body } = await graphFetch(path, { sessionId });
    const values = Array.isArray(body?.value) ? body.value : [];
    // values[0] is the header row.
    const index = new Map();
    values.slice(1).forEach(([key], i) => {
        if (key !== '' && key != null) index.set(String(key), i);
    });
    return index;
}

export async function addRow(target, sessionId, values) {
    const { body } = await graphFetch(
        `${itemRoot(target)}/tables/${encodeURIComponent(target.tableName)}/rows/add`,
        { method: 'POST', body: { values: [values] }, sessionId },
    );
    return body?.index ?? null;
}

export async function patchRow(target, sessionId, index, values) {
    await graphFetch(
        `${itemRoot(target)}/tables/${encodeURIComponent(target.tableName)}/rows/itemAt(index=${index})`,
        { method: 'PATCH', body: { values: [values] }, sessionId },
    );
}

// Resolve a workbook's driveId/itemId from a site path — used once, by
// scripts/graph-locate-workbook.mjs, to produce the env values.
export async function resolveWorkbook({ hostname, sitePath, filePath }) {
    const { body: site } = await graphFetch(`/sites/${hostname}:${sitePath}`);
    const { body: drive } = await graphFetch(`/sites/${site.id}/drive`);
    const { body: item } = await graphFetch(
        `/drives/${drive.id}/root:${filePath.startsWith('/') ? '' : '/'}${filePath}`,
    );
    return { siteId: site.id, driveId: drive.id, itemId: item.id, name: item.name, size: item.size };
}
