// Server-only request context for gateway routes: Clerk user →
// (optionally) project membership → permission check. Returns either
// { ok: true, ctx } or { ok: false, response } ready to return. This is a
// single-tenant deployment — projects are the top scope, no org layer.

import { getUser } from '../auth/user.js';
import { getDb } from '../db/neon.js';
import { hasPermission } from './access.mjs';
import { apiError } from './httpError.mjs';

// Platform admins (Clerk publicMetadata.role === 'admin') act with the
// gateway 'admin' role everywhere; everyone else uses their project role.
export async function gatewayContext({ projectId = null, permission = null } = {}) {
    const user = await getUser();
    if (!user) return { ok: false, response: apiError('UNAUTHORIZED', 'Sign in required.') };
    const sql = await getDb();
    if (!sql) return { ok: false, response: apiError('DB_UNAVAILABLE', 'Database is not configured.') };

    // Roles are PLATFORM-level only (Clerk publicMetadata.role, mirrored in
    // users.role and set on the Users console): 'admin' | 'manager' | member.
    // There is NO per-project role — project_memberships.role is vestigial and
    // ignored here. Admins and managers act workspace-wide (see + manage every
    // project); a plain member acts only on projects they belong to. Model
    // grants, budgets and keys stay admin-only via the per-permission checks
    // below — 'manager' simply lacks those perms.
    const isPlatformAdmin = user.role === 'admin';
    const isOrgManager = user.role === 'manager';
    const platformRole = isPlatformAdmin ? 'admin' : isOrgManager ? 'manager' : 'member';

    let project = null;
    let role = platformRole;
    if (projectId != null) {
        [project] = await sql`SELECT * FROM projects WHERE id = ${projectId} AND archived_at IS NULL`;
        if (!project) return { ok: false, response: apiError('NOT_FOUND', 'Project not found.') };
        // Admins/managers reach any project; a plain member must belong to it.
        if (!isPlatformAdmin && !isOrgManager) {
            const [membership] = await sql`SELECT 1 FROM project_memberships WHERE project_id = ${project.id} AND user_id = ${user.userId}`;
            if (!membership) return { ok: false, response: apiError('NOT_A_PROJECT_MEMBER', 'You are not a member of this project.') };
        }
    }

    if (permission) {
        const rolePerms = await sql`SELECT role_id, permission_id FROM role_permissions`;
        if (!hasPermission(role, permission, rolePerms)) {
            return { ok: false, response: apiError('FORBIDDEN', `Requires the '${permission}' permission.`, { role }) };
        }
    }
    return { ok: true, ctx: { sql, user, project, role, isPlatformAdmin, isOrgManager } };
}

export function clientIp(request) {
    return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
}
