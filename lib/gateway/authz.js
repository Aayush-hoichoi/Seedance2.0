// Server-only request context for gateway routes: Clerk user → org →
// (optionally) project membership → permission check. Returns either
// { ok: true, ctx } or { ok: false, response } ready to return.

import { getUser } from '../auth/user.js';
import { getDb } from '../db/neon.js';
import { resolveOrgForUser } from './db.js';
import { hasPermission } from './access.mjs';
import { apiError } from './httpError.mjs';

// Platform admins (Clerk publicMetadata.role === 'admin') act with the
// gateway 'admin' role everywhere; everyone else uses their project role.
export async function gatewayContext({ projectId = null, permission = null } = {}) {
    const user = await getUser();
    if (!user) return { ok: false, response: apiError('UNAUTHORIZED', 'Sign in required.') };
    const sql = await getDb();
    if (!sql) return { ok: false, response: apiError('DB_UNAVAILABLE', 'Database is not configured.') };

    const org = await resolveOrgForUser(sql, user.orgId, user.userId);
    if (!org) return { ok: false, response: apiError('BAD_REQUEST', 'No organization resolved — run scripts/migrate-gateway.mjs first, or select an active organization.') };

    // Org manager: a user who holds admin/manager on ANY project acts as a
    // manager across the WHOLE org — they see every project and manage its
    // members/details, even projects they aren't a direct member of. Platform
    // admins outrank them. (Model grants, budgets and keys stay admin-only via
    // the per-permission checks below — 'manager' simply lacks those perms.)
    const isPlatformAdmin = user.role === 'admin';
    // A platform 'manager' role (assigned from the Users console) is an org
    // manager everywhere; others earn it by holding admin/manager on any project.
    let isOrgManager = user.role === 'manager';
    if (!isPlatformAdmin && !isOrgManager) {
        const [row] = await sql`SELECT 1 FROM project_memberships m
            JOIN projects p ON p.id = m.project_id
            WHERE m.user_id = ${user.userId} AND p.org_id = ${org.id} AND p.archived_at IS NULL
              AND m.role IN ('admin', 'manager') LIMIT 1`;
        isOrgManager = !!row;
    }

    let project = null;
    let role = isPlatformAdmin ? 'admin' : null;
    if (projectId != null) {
        [project] = await sql`SELECT * FROM projects WHERE id = ${projectId} AND org_id = ${org.id} AND archived_at IS NULL`;
        if (!project) return { ok: false, response: apiError('NOT_FOUND', 'Project not found.') };
        const [membership] = await sql`SELECT * FROM project_memberships WHERE project_id = ${project.id} AND user_id = ${user.userId}`;
        if (isPlatformAdmin) role = 'admin';
        else if (membership) role = membership.role;
        else if (isOrgManager) role = 'manager'; // org managers act as manager on any project
        else return { ok: false, response: apiError('NOT_A_PROJECT_MEMBER', 'You are not a member of this project.') };
    }

    if (permission) {
        const rolePerms = await sql`SELECT role_id, permission_id FROM role_permissions`;
        if (!hasPermission(role, permission, rolePerms)) {
            return { ok: false, response: apiError('FORBIDDEN', `Requires the '${permission}' permission.`, { role }) };
        }
    }
    return { ok: true, ctx: { sql, user, org, project, role, isPlatformAdmin, isOrgManager } };
}

export function clientIp(request) {
    return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
}
