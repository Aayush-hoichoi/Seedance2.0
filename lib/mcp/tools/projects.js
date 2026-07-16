// lib/mcp/tools/projects.js — list_projects, create_project, update_project.
import { z } from 'zod';
import { registerTool, toolGatewayCtx, ToolError } from '../register.js';
import { writeAudit, emitEvent } from '../../gateway/db.js';

export function registerProjectTools(server) {
    registerTool(server, {
        name: 'list_projects',
        description: 'Projects you can act on, with member count and spend. Admins/managers see every project.',
        run: async ({ user }) => {
            const { sql, isPlatformAdmin, isOrgManager } = await toolGatewayCtx(user, {});
            const canManageProjects = isPlatformAdmin || isOrgManager;
            const rows = canManageProjects
                ? await sql`SELECT p.*, m2.role AS my_role,
                      (SELECT count(*)::int FROM project_memberships m WHERE m.project_id = p.id) AS member_count,
                      (SELECT COALESCE(SUM(COALESCE(b.cost_usd, b.est_cost_usd, 0)), 0)::float8 FROM billing_events b
                        WHERE b.project_id = p.id AND b.event_type IN ('settlement', 'failure')) AS spent_usd
                   FROM projects p LEFT JOIN project_memberships m2 ON m2.project_id = p.id AND m2.user_id = ${user.userId}
                   WHERE p.archived_at IS NULL ORDER BY p.created_at`
                : await sql`SELECT p.*, m2.role AS my_role,
                      (SELECT count(*)::int FROM project_memberships m WHERE m.project_id = p.id) AS member_count,
                      (SELECT COALESCE(SUM(COALESCE(b.cost_usd, b.est_cost_usd, 0)), 0)::float8 FROM billing_events b
                        WHERE b.project_id = p.id AND b.event_type IN ('settlement', 'failure')) AS spent_usd
                   FROM projects p JOIN project_memberships m2 ON m2.project_id = p.id AND m2.user_id = ${user.userId}
                   WHERE p.archived_at IS NULL ORDER BY p.created_at`;
            return { items: rows, canManageProjects };
        },
    });

    registerTool(server, {
        name: 'create_project',
        description: 'Create a project (admins/managers only). You become a member automatically.',
        schema: { name: z.string().min(1).max(200) },
        run: async ({ user, args }) => {
            const { sql, isPlatformAdmin, isOrgManager } = await toolGatewayCtx(user, {});
            if (!isPlatformAdmin && !isOrgManager) throw new ToolError('FORBIDDEN', 'Only admins or managers can create projects.');
            const [project] = await sql`INSERT INTO projects (name, created_by)
                VALUES (${args.name.trim()}, ${user.userId})
                ON CONFLICT (name) DO UPDATE SET archived_at = NULL RETURNING *`;
            await sql`INSERT INTO project_memberships (project_id, user_id, role, added_by)
                VALUES (${project.id}, ${user.userId}, 'admin', ${user.userId}) ON CONFLICT DO NOTHING`;
            await writeAudit(sql, { actorId: user.userId, actorEmail: user.email, action: 'project.create', targetType: 'project', targetId: project.id, after: { name: args.name.trim() }, ip: 'mcp' });
            return project;
        },
    });

    // Grounded on the console's PATCH + DELETE (app/api/projects/[id]/route.js):
    // per-field conditional updates with matching audit actions/events, and
    // the SAME split gating as the console — PATCH (rename/pause) requires
    // 'project.manage' (admin/owner only per lib/db/seeds.mjs
    // ROLE_PERMISSIONS — managers don't hold it), while DELETE (archive)
    // allows admins OR managers via a manual role check. One combined tool
    // can't rely on a single upfront gate without regressing one endpoint's
    // access, so both checks run, each scoped to the args that need it.
    // All validation is hoisted above every UPDATE so a rejected field (e.g.
    // archiving the Default project) can't leave earlier fields half-applied.
    // Restore (archived: false) has no console route at all — archived
    // projects 404 out of toolGatewayCtx's lookup before run() even starts
    // (lib/gateway/authz.js's WHERE archived_at IS NULL), so there is nothing
    // here to un-archive. create_project's ON CONFLICT DO UPDATE SET
    // archived_at = NULL is the real (and only) un-archive path.
    registerTool(server, {
        name: 'update_project',
        description: 'Rename, pause/resume, or archive a project. Rename/pause need project.manage (admins); archive allows admins or managers. To un-archive, call create_project with the same name.',
        schema: {
            projectId: z.number().int().positive(),
            name: z.string().min(1).max(200).optional(),
            paused: z.boolean().optional(),
            archived: z.boolean().optional(),
        },
        run: async ({ user, args }) => {
            if (args.archived === false) {
                throw new ToolError('BAD_REQUEST', 'Restore is not supported here — call create_project with the same name to un-archive.');
            }

            const { sql, project, isPlatformAdmin, isOrgManager } = await toolGatewayCtx(user, { projectId: args.projectId });

            // --- validate everything before any UPDATE runs ---
            if (args.name !== undefined || args.paused !== undefined) {
                await toolGatewayCtx(user, { projectId: args.projectId, permission: 'project.manage' }); // mirrors console PATCH
            }
            if (args.archived === true) {
                if (!isPlatformAdmin && !isOrgManager) throw new ToolError('FORBIDDEN', 'Only admins or managers can archive projects.'); // mirrors console DELETE
                if (project.name === 'Default') throw new ToolError('BAD_REQUEST', 'The Default project cannot be archived.');
            }

            if (typeof args.paused === 'boolean' && args.paused !== project.paused) {
                await sql`UPDATE projects SET paused = ${args.paused} WHERE id = ${project.id}`;
                await emitEvent(sql, {
                    projectId: project.id,
                    type: args.paused ? 'project.paused' : 'project.resumed', payload: { projectId: project.id },
                });
                await writeAudit(sql, {
                    actorId: user.userId, actorEmail: user.email, action: args.paused ? 'project.pause' : 'project.resume',
                    targetType: 'project', targetId: project.id, ip: 'mcp',
                });
            }
            if (args.name?.trim() && args.name.trim() !== project.name) {
                await sql`UPDATE projects SET name = ${args.name.trim()} WHERE id = ${project.id}`;
                await writeAudit(sql, {
                    actorId: user.userId, actorEmail: user.email, action: 'project.rename',
                    targetType: 'project', targetId: project.id, before: { name: project.name }, after: { name: args.name.trim() }, ip: 'mcp',
                });
            }
            if (args.archived === true) {
                await sql`UPDATE projects SET archived_at = now() WHERE id = ${project.id}`;
                await writeAudit(sql, { actorId: user.userId, actorEmail: user.email, action: 'project.archive', targetType: 'project', targetId: project.id, ip: 'mcp' });
            }

            const [fresh] = await sql`SELECT * FROM projects WHERE id = ${project.id}`;
            return fresh;
        },
    });
}
