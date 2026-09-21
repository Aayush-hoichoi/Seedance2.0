// Pure quota/budget engine (design §3). Dependency-injected usage numbers so
// it runs under `node --test`; the API layer supplies settled + reserved
// totals per quota (SQL sums over billing_events).

// window: 'daily' | 'monthly' | 'lifetime' → { start, resetsAt } in UTC.
export function windowBounds(window, now) {
    const t = now instanceof Date ? now : new Date(now);
    if (window === 'daily') {
        const start = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
        return { start, resetsAt: new Date(start.getTime() + 86_400_000) };
    }
    if (window === 'monthly') {
        const start = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
        return { start, resetsAt: new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1)) };
    }
    return { start: new Date(0), resetsAt: null }; // lifetime
}

// Every non-null scope dimension must match the request. Null means "all".
// This layers workspace, project, user, model, and any intersections such as
// a per-user per-model budget without special-casing every combination.
export function applicableQuotas(quotas, { projectId, userId, modelId }) {
    return (quotas || []).filter((q) => {
        if (q.deleted_at) return false;
        if (q.project_id != null && q.project_id !== projectId) return false;
        if (q.user_id != null && q.user_id !== userId) return false;
        if (q.model_id != null && q.model_id !== modelId) return false;
        return true;
    });
}

// Every applicable quota is an independent cap. A project-wide budget limits
// the whole project's usage, while a user or user+model budget limits that
// member inside the project. Headroom in one scope never overrides an exhausted
// hard limit in another scope.

// How many of a quota-type's units this request consumes. credits mirror usd
// until a credit rate exists (design §12 Q2).
export function unitsForType(type, estimate = {}) {
    if (type === 'usd' || type === 'credits') return estimate.usd ?? 0;
    if (type === 'image_count') return estimate.images ?? 0;
    if (type === 'video_seconds') return estimate.video_seconds ?? 0;
    if (type === 'request_count') return estimate.requests ?? 1;
    return 0;
}

// The enqueue-time check: settled + reserved + this request ≤ ceiling for
// every applicable quota. Soft policy stretches only that quota's ceiling by
// its configured overage percentage.
// usedByQuota / reservedByQuota: { [quota.id]: number } for the quota's window.
export function evaluateQuotas({ quotas, projectId, userId, modelId, now, estimate, usedByQuota = {}, reservedByQuota = {} }) {
    const checked = [];
    for (const quota of applicableQuotas(quotas, { projectId, userId, modelId })) {
        const units = unitsForType(quota.type, estimate);
        if (!units) continue; // request consumes none of this quota's units
        const projected = (usedByQuota[quota.id] ?? 0) + (reservedByQuota[quota.id] ?? 0) + units;
        const ceiling = Number(quota.hard_limit) * (quota.policy === 'soft' ? 1 + (quota.soft_overage_pct ?? 5) / 100 : 1);
        checked.push({ quota, projected, ceiling, over: projected > ceiling });
    }
    const violations = checked
        .filter((c) => c.over)
        .map(({ quota, projected, ceiling }) => ({
            quota, projected, ceiling, resetsAt: windowBounds(quota.window, now).resetsAt,
        }));
    // Tightest limit first so the error message names the one that binds.
    violations.sort((a, b) => Number(a.quota.hard_limit) - Number(b.quota.hard_limit));
    return { ok: violations.length === 0, violations };
}

// User-facing balance rows for every applicable USD quota. Tightest headroom
// first because that is the amount the user can actually spend before one of
// the layered budgets rejects another request.
export function quotaBalances({ quotas, projectId, userId, modelId, usedByQuota = {}, reservedByQuota = {} }) {
    const rows = applicableQuotas(quotas, { projectId, userId, modelId })
        .filter((q) => q.type === 'usd')
        .map((quota) => {
            const limit = Number(quota.hard_limit);
            const used = Number(usedByQuota[quota.id] ?? 0);
            const reserved = Number(reservedByQuota[quota.id] ?? 0);
            return {
                quota,
                limit,
                used,
                reserved,
                remaining: Math.max(0, limit - used - reserved),
            };
        });
    return rows.sort((a, b) => a.remaining - b.remaining || a.limit - b.limit);
}

// Alert thresholds (as % of hard_limit, NOT the soft ceiling) crossed when
// usage moves before → after. Emitted once per (quota, window, threshold) —
// the caller dedupes via quota_alerts_sent.
export function thresholdsCrossed(quota, before, after) {
    const limit = Number(quota.hard_limit);
    if (!limit || after <= before) return [];
    return (quota.alert_thresholds ?? [80, 90, 100])
        .filter((t) => before < (limit * t) / 100 && after >= (limit * t) / 100);
}
