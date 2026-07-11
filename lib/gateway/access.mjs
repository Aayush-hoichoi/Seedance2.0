// Pure model-access decision engine. Dependency-injected rows (no DB imports)
// so it runs under `node --test`. Precedence per the design §2:
//   user DENY > user ALLOW > project grant > org default > deny-by-default.
// Every caller passes rows already scoped to (user, project) by SQL.

// A grant/override row counts only while un-revoked and inside its validity
// window: valid_from inclusive, valid_until exclusive, nulls unbounded.
export function isActive(row, now) {
    if (!row || row.revoked_at) return false;
    const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
    if (row.valid_from && t < new Date(row.valid_from).getTime()) return false;
    if (row.valid_until && t >= new Date(row.valid_until).getTime()) return false;
    return true;
}

// → { allowed, rule } where rule names which precedence level decided, so the
// UI can explain itself ("denied by a user override until 2026-08-01").
export function effectiveAccess({ modelId, now, overrides = [], grants = [], defaultModelIds = [] }) {
    if (!modelId) return { allowed: false, rule: 'deny_default' };

    const mine = overrides.filter((o) => o.model_id === modelId && isActive(o, now));
    if (mine.some((o) => o.effect === 'deny')) return { allowed: false, rule: 'deny_override' };
    if (mine.some((o) => o.effect === 'allow')) return { allowed: true, rule: 'allow_override' };

    if (grants.some((g) => g.model_id === modelId && isActive(g, now))) {
        return { allowed: true, rule: 'project_grant' };
    }
    if (defaultModelIds.includes(modelId)) return { allowed: true, rule: 'org_default' };
    return { allowed: false, rule: 'deny_default' };
}

// rolePermissionRows: [{ role_id, permission_id }] (the whole table — it's tiny).
export function hasPermission(roleId, permissionId, rolePermissionRows = []) {
    if (!roleId || !permissionId) return false;
    return rolePermissionRows.some((r) => r.role_id === roleId && r.permission_id === permissionId);
}
