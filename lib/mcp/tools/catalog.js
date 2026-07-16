import { z } from 'zod';
import { registerTool, ToolError } from '../register.js';
import { MODELS, IMAGE_MODELS, GATED_MODEL_IDS, IMAGE_GATED_MODEL_IDS } from '../../seedance/constants.js';
import { getApprovedModelIds, getRequestsForUser, getMonthSpendUsd, requestAccess } from '../../access/db.js';
import { notifySlackAccessRequested } from '../../notify/slack.mjs';
import { getDb } from '../../db/neon.js';

async function allowedIdsFor(userId) {
    const approved = await getApprovedModelIds(userId);
    const openIds = [...MODELS, ...IMAGE_MODELS].filter((m) => !m.gated).map((m) => m.id);
    return [...new Set([...openIds, ...approved])];
}

export function registerCatalogTools(server) {
    registerTool(server, {
        name: 'list_models',
        description: 'All video + image models with gating status, resolutions, and whether YOU can use each one right now.',
        run: async ({ user }) => {
            const allowed = await allowedIdsFor(user.userId);
            const shape = (m, category) => ({
                id: m.id, name: m.name, category, gated: !!m.gated,
                resolutions: m.resolutions ?? null, allowed: allowed.includes(m.id),
            });
            return {
                models: [...MODELS.map((m) => shape(m, 'video')), ...IMAGE_MODELS.map((m) => shape(m, 'image'))],
                hint: 'For gated models you cannot use, call request_model_access.',
            };
        },
    });

    registerTool(server, {
        name: 'get_my_access',
        description: 'Your allowed models, pending/decided access requests, and this month\'s spend.',
        run: async ({ user }) => ({
            allowedModelIds: await allowedIdsFor(user.userId),
            requests: await getRequestsForUser(user.userId),
            role: user.role ?? 'member',
            monthSpendUsd: await getMonthSpendUsd(user.userId),
        }),
    });

    registerTool(server, {
        name: 'request_model_access',
        description: 'Request access to a gated model for a project. An admin approves via Slack or the console.',
        schema: {
            modelId: z.string().min(1).max(100),
            projectId: z.number().int().positive(),
            note: z.string().max(500).optional(),
        },
        run: async ({ user, args }) => {
            if (!GATED_MODEL_IDS.includes(args.modelId) && !IMAGE_GATED_MODEL_IDS.includes(args.modelId)) {
                throw new ToolError('BAD_REQUEST', 'That model does not require a request.');
            }
            if (!user.email) throw new ToolError('BAD_REQUEST', 'No email on your account.');
            const sql = await getDb();
            if (!sql) throw new ToolError('DB_UNAVAILABLE', 'Access store unavailable.');
            const [member] = await sql`SELECT p.name FROM project_memberships m
                JOIN projects p ON p.id = m.project_id
                WHERE m.project_id = ${args.projectId} AND m.user_id = ${user.userId} LIMIT 1`;
            if (!member) throw new ToolError('NOT_A_PROJECT_MEMBER', 'You are not a member of that project.');
            const { id, status } = await requestAccess(user.userId, user.email, args.modelId, args.note ?? null, args.projectId);
            if (status === 'pending') {
                await notifySlackAccessRequested({ id, email: user.email, modelId: args.modelId, projectName: member.name, note: args.note ?? null }).catch(() => {});
            }
            return { ok: true, status };
        },
    });
}
