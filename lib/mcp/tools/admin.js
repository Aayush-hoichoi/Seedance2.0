// lib/mcp/tools/admin.js — get_usage, access-request admin, quotas, audit.
import { z } from 'zod';
import { registerTool, toolGatewayCtx, ToolError } from '../register.js';
import { usageRollup } from '../../gateway/usageQuery.js';
import { usageForQuotas, writeAudit } from '../../gateway/db.js';
import { listRequests, setRequestStatus } from '../../access/db.js';
import { nextStatus } from '../../access/requestStatus.mjs';
import { syncGatewayOverride } from '../../access/gatewaySync.mjs';

const QUOTA_TYPES = ['usd', 'credits', 'image_count', 'video_seconds', 'request_count'];
const QUOTA_WINDOWS = ['daily', 'monthly', 'lifetime'];

export function registerAdminTools(server) {
    registerTool(server, {
        name: 'get_usage',
        description: 'Spend rollup. With projectId: that project (needs usage.view there). Without: workspace-wide (admin/manager only).',
        schema: {
            projectId: z.number().int().positive().optional(),
            groupBy: z.enum(['model', 'user', 'provider', 'project', 'day']).optional(),
            from: z.string().max(30).optional(),
            to: z.string().max(30).optional(),
        },
        run: async ({ user, args }) => {
            const ctx = await toolGatewayCtx(user, args.projectId ? { projectId: args.projectId, permission: 'usage.view' } : {});
            if (!args.projectId && !ctx.isPlatformAdmin && !ctx.isOrgManager) {
                throw new ToolError('FORBIDDEN', 'Workspace-wide usage needs an admin or manager role — pass a projectId.');
            }
            const rows = await usageRollup(ctx.sql, {
                projectId: args.projectId ?? null, groupBy: args.groupBy ?? 'model',
                from: args.from ?? null, to: args.to ?? null,
            });
            return { rows };
        },
    });

    registerTool(server, {
        name: 'list_access_requests',
        description: 'Pending + decided model access requests (admin).',
        run: async ({ user }) => {
            await toolGatewayCtx(user, { permission: 'model.grant' });
            return { requests: await listRequests() };
        },
    });

    registerTool(server, {
        name: 'resolve_access_request',
        description: 'Approve or deny a model access request (admin). Approval grants until validUntilDays from now (default 2, like Slack).',
        schema: {
            requestId: z.number().int().positive(),
            action: z.enum(['approve', 'deny']),
            validUntilDays: z.number().int().min(1).max(365).optional(),
        },
        run: async ({ user, args }) => {
            await toolGatewayCtx(user, { permission: 'model.grant' });
            const approve = args.action === 'approve';
            const validUntil = approve
                ? new Date(Date.now() + (args.validUntilDays ?? (Number(process.env.SLACK_APPROVE_DAYS) || 2)) * 86400000).toISOString()
                : null;
            const byUser = `${user.email} (MCP)`;
            const row = await setRequestStatus(args.requestId, nextStatus(approve ? 'approve' : 'revoke'), byUser, validUntil);
            if (!row) throw new ToolError('NOT_FOUND', 'Request not found — it may already have been handled.');
            try {
                await syncGatewayOverride({ action: approve ? 'approve' : 'revoke', row, validUntil, admin: { userId: user.userId, email: user.email } });
            } catch (error) {
                console.error('[mcp] gateway sync failed:', error.message); // status already saved — same as Slack path
            }
            return { ok: true, requestId: args.requestId, status: row.status, expiresAt: row.expires_at ?? validUntil };
        },
    });

    registerTool(server, {
        name: 'list_quotas',
        description: 'Active budgets/quotas with usage (admin).',
        run: async ({ user }) => {
            const { sql } = await toolGatewayCtx(user, { permission: 'quota.manage' });
            const items = await sql`SELECT q.*, p.name AS project_name, m.display_name AS model_name FROM quotas q
                LEFT JOIN projects p ON p.id = q.project_id
                LEFT JOIN models m ON m.id = q.model_id
                WHERE q.deleted_at IS NULL ORDER BY q.created_at DESC`;
            const { usedByQuota, reservedByQuota } = await usageForQuotas(sql, items);
            return { items: items.map((q) => ({ ...q, used: usedByQuota[q.id] ?? 0, reserved: reservedByQuota[q.id] ?? 0 })) };
        },
    });

    registerTool(server, {
        name: 'set_quota',
        description: 'Create a budget/quota (admin). Optional projectId, userId, and modelId scopes can be combined, including per-user per-model.',
        schema: {
            type: z.enum(QUOTA_TYPES),
            window: z.enum(QUOTA_WINDOWS),
            hardLimit: z.number().positive(),
            projectId: z.number().int().positive().optional(),
            userId: z.string().max(200).optional(),
            modelId: z.string().max(200).optional(),
            policy: z.enum(['hard', 'soft']).optional(),
        },
        run: async ({ user, args }) => {
            const { sql } = await toolGatewayCtx(user, { permission: 'quota.manage' });
            if (args.modelId) {
                const [model] = await sql`SELECT id FROM models WHERE id = ${args.modelId} AND active = true`;
                if (!model) throw new ToolError('BAD_REQUEST', 'modelId must identify an active model.');
            }
            const [quota] = await sql`INSERT INTO quotas
                (project_id, user_id, model_id, type, "window", hard_limit, policy, soft_overage_pct, alert_thresholds, created_by)
                VALUES (${args.projectId ?? null}, ${args.userId ?? null}, ${args.modelId ?? null}, ${args.type}, ${args.window}, ${args.hardLimit},
                        ${args.policy === 'soft' ? 'soft' : 'hard'}, 5, ${[80, 90, 100]}, ${user.userId})
                RETURNING *`;
            await writeAudit(sql, { actorId: user.userId, actorEmail: user.email, action: 'quota.create', targetType: 'quota', targetId: quota.id, after: quota, ip: 'mcp' });
            return quota;
        },
    });

    registerTool(server, {
        name: 'view_audit',
        description: 'Audit trail, newest first (admin). Filters: actor (id/email), action prefix, target type, from/to ISO dates.',
        schema: {
            actor: z.string().max(200).optional(),
            action: z.string().max(100).optional(),
            target: z.string().max(50).optional(),
            from: z.string().max(30).optional(),
            to: z.string().max(30).optional(),
        },
        run: async ({ user, args }) => {
            const { sql } = await toolGatewayCtx(user, { permission: 'audit.view' });
            const rows = await sql.query(
                `SELECT * FROM audit_log
                 WHERE ($1::text IS NULL OR actor_id = $1 OR actor_email ILIKE '%' || $1 || '%')
                   AND ($2::text IS NULL OR action ILIKE $2 || '%')
                   AND ($3::text IS NULL OR target_type = $3)
                   AND ($4::timestamptz IS NULL OR created_at >= $4)
                   AND ($5::timestamptz IS NULL OR created_at < $5)
                 ORDER BY created_at DESC LIMIT 500`,
                [args.actor ?? null, args.action ?? null, args.target ?? null, args.from ?? null, args.to ?? null],
            );
            return { rows };
        },
    });
}
