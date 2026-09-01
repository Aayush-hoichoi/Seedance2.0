// Browser-only ledger analytics. The ledger endpoint deliberately pages rows,
// so these calculations describe exactly the records loaded in the current
// view; they never request an aggregate from the server.

const STATUS_META = {
    succeeded: { label: 'Succeeded', color: '#4ADE80', outcome: 'success' },
    failed: { label: 'Failed', color: '#F87171', outcome: 'failure' },
    timed_out: { label: 'Timed out', color: '#FB923C', outcome: 'failure' },
    rejected: { label: 'Rejected', color: '#FACC15', outcome: 'failure' },
    cancelled: { label: 'Cancelled', color: '#94A3B8', outcome: 'failure' },
    queued: { label: 'Queued', color: '#60A5FA', outcome: 'active' },
    running: { label: 'Running', color: '#A78BFA', outcome: 'active' },
};

const ORDER = ['succeeded', 'failed', 'timed_out', 'rejected', 'cancelled', 'queued', 'running', 'other'];

function summarize(counts, total) {
    const segments = ORDER
        .filter((status) => Number(counts[status] || 0) > 0)
        .map((status) => {
            const meta = STATUS_META[status] || { label: 'Other', color: '#7C7A88', outcome: 'active' };
            return { key: status, label: meta.label, value: Number(counts[status]), color: meta.color, outcome: meta.outcome };
        });

    const succeeded = segments.filter((s) => s.outcome === 'success').reduce((sum, s) => sum + s.value, 0);
    const failed = segments.filter((s) => s.outcome === 'failure').reduce((sum, s) => sum + s.value, 0);
    const active = segments.filter((s) => s.outcome === 'active').reduce((sum, s) => sum + s.value, 0);
    const completed = succeeded + failed;

    return {
        segments,
        total,
        succeeded,
        failed,
        active,
        completed,
        successRate: completed ? (succeeded / completed) * 100 : null,
    };
}

export function buildLedgerStatusAnalytics(rows = []) {
    const counts = {};
    for (const row of rows) {
        const raw = String(row?.Status || '').trim().toLowerCase();
        const status = STATUS_META[raw] ? raw : 'other';
        counts[status] = (counts[status] || 0) + 1;
    }
    return summarize(counts, rows.length);
}

// The ledger list already returns a count for the entire filtered view. Its
// status buckets are calculated by that same request, so this stays one fetch
// while avoiding the inaccurate "current page only" view.
export function buildLedgerStatusAnalyticsFromCounts(statuses = {}, total = 0) {
    const counts = {};
    let known = 0;
    for (const status of Object.keys(STATUS_META)) {
        const value = Math.max(0, Math.floor(Number(statuses[status]) || 0));
        counts[status] = value;
        known += value;
    }
    counts.other = Math.max(0, Number(total || 0) - known);
    return summarize(counts, Number(total || 0));
}
