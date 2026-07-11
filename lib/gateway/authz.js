// Server-only request context for gateway routes: Clerk user → org →
// (optionally) project membership → permission check. Returns either
// { ok: true, ctx } or { ok: false, response } ready to return.

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

    const [org] = await sql`SELECT * FROM organizations WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`;
    if (!org) return { ok: false, response: apiError('BAD_REQUEST', 'No organization yet — run scripts/migrate-gateway.mjs first.') };

    let project = null;
    let role = user.role === 'admin' ? 'admin' : null;
    if (projectId != null) {
        [project] = await sql`SELECT * FROM projects WHERE id = ${projectId} AND org_id = ${org.id} AND archived_at IS NULL`;
        if (!project) return { ok: false, response: apiError('NOT_FOUND', 'Project not found.') };
        const [membership] = await sql`SELECT * FROM project_memberships WHERE project_id = ${project.id} AND user_id = ${user.userId}`;
        if (!membership && role !== 'admin') {
            return { ok: false, response: apiError('NOT_A_PROJECT_MEMBER', 'You are not a member of this project.') };
        }
        role = role === 'admin' ? 'admin' : membership.role;
    }

    if (permission) {
        const rolePerms = await sql`SELECT role_id, permission_id FROM role_permissions`;
        if (!hasPermission(role, permission, rolePerms)) {
            return { ok: false, response: apiError('FORBIDDEN', `Requires the '${permission}' permission.`, { role }) };
        }
    }
    return { ok: true, ctx: { sql, user, org, project, role } };
}

export function clientIp(request) {
    return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
}
