// Pure assembly of one user's cross-project access + spend picture, for the
// Access explorer. Dependency-injected rows (no DB imports) so it runs under
// `node --test`. Access decisions reuse effectiveAccess — the SAME function
// the submit pipeline enforces with — so this page can never disagree with
// what the gateway actually allows.

import { effectiveAccess } from './access.mjs';

// memberships: [{ project_id, name, paused, archived_at }]
// models:      [{ id, display_name, category, is_default }] (active only)
// grants:      project_model_grants rows for the member projects
// overrides:   user_model_overrides rows for this user (all projects)
// spendRows:   userSpendByProjectModel output
// → project entries sorted members-first then spend-desc. A project the user
//   spent in but no longer belongs to still appears (member: false, no access
//   matrix) so the spend donut always sums to the user's true total.
export function buildUserAccessReport({ memberships = [], models = [], grants = [], overrides = [], spendRows = [], now = new Date() }) {
    const defaultModelIds = models.filter((m) => m.is_default).map((m) => m.id);
    const projects = new Map();
    for (const m of memberships) {
        projects.set(m.project_id, {
            id: m.project_id, name: m.name, paused: !!m.paused, archived: !!m.archived_at, member: true,
        });
    }
    for (const row of spendRows) {
        if (!projects.has(row.project_id)) {
            projects.set(row.project_id, { id: row.project_id, name: row.project_name, paused: false, archived: false, member: false });
        }
    }

    const out = [...projects.values()].map((p) => {
        const spend = spendRows.filter((r) => r.project_id === p.id);
        const access = p.member
            ? models.map((m) => {
                const d = effectiveAccess({
                    modelId: m.id,
                    now,
                    overrides: overrides.filter((o) => o.project_id === p.id),
                    grants: grants.filter((g) => g.project_id === p.id),
                    defaultModelIds,
                });
                return { model_id: m.id, allowed: d.allowed, rule: d.rule, max_resolution: d.maxResolution ?? null };
            })
            : [];
        return {
            ...p,
            access,
            spend,
            cost_usd: spend.reduce((s, r) => s + Number(r.cost_usd || 0), 0),
            generations: spend.reduce((s, r) => s + Number(r.generations || 0), 0),
            failures: spend.reduce((s, r) => s + Number(r.failures || 0), 0),
        };
    });
    out.sort((a, b) => (b.member - a.member) || (b.cost_usd - a.cost_usd) || String(a.name).localeCompare(String(b.name)));
    return out;
}
