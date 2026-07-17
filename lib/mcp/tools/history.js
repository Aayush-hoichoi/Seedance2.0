// lib/mcp/tools/history.js — list_generations, get_generation, browse_gallery,
// bin_generation, like_generation. Prompt privacy identical to the routes.
import { z } from 'zod';
import { registerTool, toolGatewayCtx, ToolError } from '../register.js';
import { getJob } from '../../gateway/db.js';
import { sweep } from '../../gateway/sweep.mjs';
import { hasPermission } from '../../gateway/access.mjs';
import { listCreators, listUserGenerations, listLikedGenerations, getTaskOwner } from '../../access/db.js';
import { toItem, presignKey, imageUrlsFromResult } from '../../seedance/galleryItem.mjs';
import { archiveKeyForTask } from '../../seedance/archiveKey.mjs';
import { getDb } from '../../db/neon.js';

async function canSeePrompts(sql, role) {
    const rolePerms = await sql`SELECT role_id, permission_id FROM role_permissions`;
    return hasPermission(role, 'prompt.view', rolePerms);
}

function redact(job, own, seePrompts) {
    if (own || seePrompts) return job;
    return { ...job, request_body: { category: job.request_body?.category ?? null } };
}

// Upsert helpers over seedance_prompts — copied verbatim (statement + conflict
// key) from app/api/seedance/bin/route.js (deleted) and
// app/api/seedance/likes/route.js (liked). The neon client has no identifier
// interpolation, so each column gets its own explicit statement rather than
// the `${sql(column)}` stand-in from the task brief.
async function upsertDeleted(sql, taskId, deleted) {
    await sql`INSERT INTO seedance_prompts (task_id, deleted)
        VALUES (${taskId}, ${deleted})
        ON CONFLICT (task_id) DO UPDATE SET deleted = EXCLUDED.deleted`;
}

async function upsertLiked(sql, taskId, liked) {
    await sql`INSERT INTO seedance_prompts (task_id, liked)
        VALUES (${taskId}, ${liked})
        ON CONFLICT (task_id) DO UPDATE SET liked = EXCLUDED.liked`;
}

export function registerHistoryTools(server) {
    registerTool(server, {
        name: 'list_generations',
        description: 'Recent generations. scope "mine" (default) = yours; "project" = everyone’s in the project (needs usage.view).',
        schema: {
            projectId: z.number().int().positive().optional(),
            scope: z.enum(['mine', 'project']).optional(),
            category: z.enum(['video', 'image']).optional(),
        },
        run: async ({ user, args }) => {
            const scope = args.scope === 'project' ? 'project' : 'mine';
            const ctx = await toolGatewayCtx(user, args.projectId
                ? { projectId: args.projectId, permission: scope === 'project' ? 'usage.view' : 'generation.create' }
                : {});
            const { sql, role } = ctx;
            const category = args.category ?? null;
            const rows = args.projectId
                ? (scope === 'project'
                    ? await sql`SELECT * FROM jobs WHERE project_id = ${args.projectId}
                        AND (${category}::text IS NULL OR coalesce(request_body->>'category', 'video') = ${category})
                        ORDER BY created_at DESC LIMIT 100`
                    : await sql`SELECT * FROM jobs WHERE project_id = ${args.projectId} AND user_id = ${user.userId}
                        AND (${category}::text IS NULL OR coalesce(request_body->>'category', 'video') = ${category})
                        ORDER BY created_at DESC LIMIT 100`)
                : await sql`SELECT * FROM jobs WHERE user_id = ${user.userId}
                    AND (${category}::text IS NULL OR coalesce(request_body->>'category', 'video') = ${category})
                    ORDER BY created_at DESC LIMIT 100`;
            const seePrompts = await canSeePrompts(sql, role);
            return { items: rows.map((j) => redact(j, j.user_id === user.userId, seePrompts)) };
        },
    });

    registerTool(server, {
        name: 'get_generation',
        description: 'One generation by gateway id: full job row plus a presigned archive URL for finished videos.',
        schema: { generationId: z.number().int().positive() },
        run: async ({ user, args }) => {
            sweep().catch(() => {}); // status polls drive queue maintenance (no cron on Hobby)
            const base = await toolGatewayCtx(user, {});
            const job = await getJob(base.sql, args.generationId);
            if (!job) throw new ToolError('NOT_FOUND', 'Generation not found.');
            let role = base.role;
            if (job.user_id !== user.userId) {
                role = (await toolGatewayCtx(user, { projectId: job.project_id, permission: 'usage.view' })).role;
            }
            const own = job.user_id === user.userId;
            const seePrompts = own ? true : await canSeePrompts(base.sql, role);
            const isVideo = (job.request_body?.category ?? 'video') === 'video';
            const archiveUrl = isVideo && job.provider_task_id ? presignKey(archiveKeyForTask(job.provider_task_id)) : null;
            const imageUrls = isVideo ? null : imageUrlsFromResult(job.result);
            return { ...redact(job, own, seePrompts), archiveUrl, imageUrls };
        },
    });

    registerTool(server, {
        name: 'browse_gallery',
        description: 'Community gallery. No args = creators list; userId = that creator’s items; liked=true = all liked items; mine=true = your full history.',
        schema: {
            userId: z.string().max(200).optional(),
            liked: z.boolean().optional(),
            mine: z.boolean().optional(),
        },
        run: async ({ user, args }) => {
            if (args.mine) return { items: (await listUserGenerations(user.userId)).map(toItem) };
            if (args.liked) {
                return { items: (await listLikedGenerations()).map((r) => ({
                    ...toItem(r),
                    creator: r.user_id ? { id: r.user_id, name: r.creator_name, email: r.creator_email } : null,
                })) };
            }
            if (args.userId) return { items: (await listUserGenerations(args.userId)).map(toItem) };
            return { me: user.userId, creators: await listCreators() };
        },
    });

    registerTool(server, {
        name: 'bin_generation',
        description: 'Soft-delete (value=true) or restore (value=false) one of YOUR generations by ModelArk task id.',
        schema: { taskId: z.string().min(1).max(200), value: z.boolean() },
        run: async ({ user, args }) => {
            // Mirrors app/api/seedance/bin/route.js: everyone can see/reuse every
            // generation, but only its creator (or an admin) can bin it. Tasks
            // from before per-user tracking have no recorded owner and stay open.
            const owner = await getTaskOwner(args.taskId).catch(() => null);
            if (owner && owner !== user.userId && user.role !== 'admin') {
                throw new ToolError('FORBIDDEN', 'Only the creator can remove this generation.');
            }
            const sql = await getDb();
            if (!sql) throw new ToolError('DB_UNAVAILABLE', 'Store unavailable.');
            await upsertDeleted(sql, args.taskId, args.value);
            return { ok: true, taskId: args.taskId, deleted: args.value };
        },
    });

    registerTool(server, {
        name: 'like_generation',
        description: 'Like (value=true) or unlike (value=false) any generation by ModelArk task id.',
        schema: { taskId: z.string().min(1).max(200), value: z.boolean() },
        run: async ({ args }) => {
            // Mirrors app/api/seedance/likes/route.js: no ownership check — a
            // like is a shared mark on the task, not a creator-only action.
            const sql = await getDb();
            if (!sql) throw new ToolError('DB_UNAVAILABLE', 'Store unavailable.');
            await upsertLiked(sql, args.taskId, args.value);
            return { ok: true, taskId: args.taskId, liked: args.value };
        },
    });
}
