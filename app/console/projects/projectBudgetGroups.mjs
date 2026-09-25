// The project's overall budget is the everyone-scope, all-models USD quota:
// the ceiling the whole project spends against, and the pool every member
// budget is carved out of. The Budget tab gives it its own card, so it is
// deliberately kept OUT of the shared-pool group below.
const isOverall = (q) => !q.user_id && !q.model_id && q.type === 'usd';

const mergeBreakdowns = (rows) => {
    const byModel = new Map();
    for (const r of rows) {
        for (const m of r.model_breakdown ?? []) {
            const entry = byModel.get(m.model_id) || { model_id: m.model_id, model_name: m.model_name, cost_usd: 0 };
            entry.cost_usd += m.cost_usd || 0;
            byModel.set(m.model_id, entry);
        }
    }
    return [...byModel.values()].sort((a, b) => b.cost_usd - a.cost_usd);
};

// Card model for the overall budget. `capUsd` null means no cap is set — the
// project is uncapped and only its spend is tracked.
export function projectOverallBudget({ quotas = [], spendRows = [] }) {
    const quota = quotas.find(isOverall) || null;
    return {
        quota,
        capUsd: quota ? Number(quota.hard_limit) : null,
        // With a cap the quota row already carries project-wide totals from the
        // same billing-event math that enforces it; without one, roll up spend.
        // In-flight money has no project-wide figure until a cap exists.
        spentUsd: quota ? Number(quota.used || 0) : spendRows.reduce((sum, r) => sum + (r.cost_usd || 0), 0),
        reservedUsd: quota ? Number(quota.reserved || 0) : 0,
        // What members already hold. Only USD budgets are sub-allocations — an
        // image-count or seconds cap measures something the dollar cap does not.
        allocatedUsd: quotas
            .filter((q) => q.user_id && q.type === 'usd')
            .reduce((sum, q) => sum + Number(q.hard_limit), 0),
        spendBreakdown: mergeBreakdowns(spendRows),
    };
}

// Grouping for the project Budget tab: per-scope quota rows → one group per
// person (user_id null = the shared "Everyone" pool) so the UI renders a
// single card per user. Members with spend but no budget still get a group —
// uncapped spenders must stay visible to admins.
// spendRows come from /usage?group_by=user, keyed by email (user id when the
// user row is gone); quotas store the user id, so members bridges the two.
export function groupProjectBudgets({ quotas = [], spendRows = [], members = [] }) {
    const byUser = new Map();
    for (const q of quotas.filter((q) => !isOverall(q))) {
        const key = q.user_id || '';
        if (!byUser.has(key)) byUser.set(key, []);
        byUser.get(key).push(q);
    }
    for (const row of spendRows) {
        const member = members.find((m) => m.email === row.key || m.user_id === row.key);
        if (member && !byUser.has(member.user_id)) byUser.set(member.user_id, []);
    }

    const emailFor = (userId) => members.find((m) => m.user_id === userId)?.email || null;
    const spendRowFor = (userId) => {
        const email = emailFor(userId);
        return spendRows.find((r) => r.key === email || r.key === userId);
    };
    const projectSpend = spendRows.reduce((sum, r) => sum + (r.cost_usd || 0), 0);

    // Total allotted without double counting: an "All models" budget already
    // covers every per-model sub-cap layered under it, so it IS the allotment;
    // only without one do the per-model caps add up.
    const allottedFor = (rows) => {
        const usd = rows.filter((q) => q.type === 'usd');
        if (!usd.length) return null;
        const overall = usd.find((q) => !q.model_id);
        return overall ? Number(overall.hard_limit) : usd.reduce((s, q) => s + Number(q.hard_limit), 0);
    };
    // In-flight money follows the same no-double-counting rule: the overall
    // budget's reservation total already contains every per-model one.
    const reservedFor = (rows) => {
        const usd = rows.filter((q) => q.type === 'usd');
        const overall = usd.find((q) => !q.model_id);
        return overall ? Number(overall.reserved || 0) : usd.reduce((s, q) => s + Number(q.reserved || 0), 0);
    };
    return [...byUser.entries()]
        .map(([userId, rows]) => {
            const spendBreakdown = userId
                ? mergeBreakdowns([spendRowFor(userId)].filter(Boolean))
                : mergeBreakdowns(spendRows);
            const overall = rows.find((q) => !q.model_id && q.type === 'usd');
            return {
                userId: userId || null,
                // "All models" budget leads, then model caps by spend.
                rows: [...rows].sort((a, b) => (a.model_id ? 1 : 0) - (b.model_id ? 1 : 0)
                    || Number(b.used || 0) - Number(a.used || 0)),
                spentUsd: userId ? (spendRowFor(userId)?.cost_usd ?? 0) : projectSpend,
                allottedUsd: allottedFor(rows),
                reservedUsd: reservedFor(rows),
                spendBreakdown,
                // Every used model must show a bar: models with real spend but
                // no budget of their own get a row scaled against the overall
                // cap (null when the user has no "All models" budget).
                overallCapUsd: overall ? Number(overall.hard_limit) : null,
                unbudgeted: spendBreakdown.filter((m) => !rows.some((q) => q.model_id === m.model_id)),
            };
        })
        .sort((a, b) => {
            if ((a.userId === null) !== (b.userId === null)) return a.userId === null ? -1 : 1;
            return b.spentUsd - a.spentUsd;
        });
}
