import { z } from 'zod';

import { getJob } from '../../gateway/db.js';
import { sweep } from '../../gateway/sweep.mjs';
import { fallbackContentForGenerations, normalizeGeneration } from '../media.mjs';
import { MEDIA_APP_RESOURCE_URI } from '../mediaAppConfig.mjs';
import { inlineImageBlocksForResults } from '../inlineImages.mjs';
import { rawContent, registerTool, ToolError, toolGatewayCtx } from '../register.js';
import { waitForGenerations } from '../waitForGenerations.mjs';

const generationId = z.number().int().positive();

async function createAccessibleJobLoader(user, generationIds) {
    const { sql } = await toolGatewayCtx(user, {});
    const authorizedProjects = new Set();

    return async () => {
        const jobs = [];
        for (const id of generationIds) {
            const job = await getJob(sql, id);
            if (!job) throw new ToolError('NOT_FOUND', `Generation ${id} not found.`);
            if (job.user_id !== user.userId && !authorizedProjects.has(job.project_id)) {
                await toolGatewayCtx(user, { projectId: job.project_id, permission: 'usage.view' });
                authorizedProjects.add(job.project_id);
            }
            jobs.push(job);
        }
        return jobs;
    };
}

async function mediaToolResult(jobs, layout) {
    // One timestamp per result means every signed URL in a gallery has the
    // same clear validity window and each call refreshes the whole collection.
    const now = new Date();
    const generations = jobs.map((job) => normalizeGeneration(job, { now }));
    const imageBlocks = await inlineImageBlocksForResults(
        jobs.filter((job) => job.status === 'succeeded' && job.request_body?.category === 'image').map((job) => job.result),
        { maxImages: 4 },
    );
    return rawContent([
        ...fallbackContentForGenerations(generations),
        ...imageBlocks,
    ], {
        structuredContent: {
            layout,
            generations,
            allTerminal: generations.every((item) => item.terminal),
        },
    });
}

export function registerMediaTools(server) {
    registerTool(server, {
        name: 'wait_for_generations',
        title: 'Wait for generations',
        description: 'Long-poll 1–12 image/video generations for 10–15 seconds. Use the gateway generationId returned by create_image, or jobId returned by create_video. When complete, call display_generation or display_generations.',
        schema: {
            generationIds: z.array(generationId).min(1).max(12),
            timeoutSeconds: z.number().int().min(10).max(15).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        run: async ({ user, args }) => {
            const load = await createAccessibleJobLoader(user, args.generationIds);
            const waited = await waitForGenerations({
                load,
                // Guarded globally to once/minute; this advances serverless jobs
                // without multiplying provider polls for concurrent clients.
                advance: async () => { await sweep().catch(() => false); },
                timeoutMs: (args.timeoutSeconds ?? 15) * 1000,
                intervalMs: 1000,
            });
            const result = await mediaToolResult(waited.jobs, waited.jobs.length === 1 ? 'single' : 'gallery');
            result.__mcpResult.structuredContent.timedOut = waited.timedOut;
            return result;
        },
    });

    registerTool(server, {
        name: 'display_generation',
        title: 'Display generation',
        description: 'Render one image or video generation in an interactive MCP App. Pending jobs continue polling automatically. Includes image blocks and links for clients without MCP Apps.',
        schema: { generationId },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        meta: { ui: { resourceUri: MEDIA_APP_RESOURCE_URI, visibility: ['model', 'app'] } },
        run: async ({ user, args }) => {
            const load = await createAccessibleJobLoader(user, [args.generationId]);
            return mediaToolResult(await load(), 'single');
        },
    });

    registerTool(server, {
        name: 'display_generations',
        title: 'Display generations',
        description: 'Render an exact batch of up to 60 image/video generations in an interactive MCP App gallery. Pending jobs continue polling automatically. Includes image blocks and links for clients without MCP Apps.',
        schema: { generationIds: z.array(generationId).min(1).max(60) },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        meta: { ui: { resourceUri: MEDIA_APP_RESOURCE_URI, visibility: ['model', 'app'] } },
        run: async ({ user, args }) => {
            const load = await createAccessibleJobLoader(user, args.generationIds);
            return mediaToolResult(await load(), 'gallery');
        },
    });

    registerTool(server, {
        name: 'get_job_status',
        title: 'Refresh generation status',
        description: 'App-only status refresh used by the generation media widget.',
        schema: { generationId },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        meta: { ui: { resourceUri: MEDIA_APP_RESOURCE_URI, visibility: ['app'] } },
        run: async ({ user, args }) => {
            await sweep().catch(() => false);
            const load = await createAccessibleJobLoader(user, [args.generationId]);
            const [job] = await load();
            const generation = normalizeGeneration(job);
            return rawContent(fallbackContentForGenerations([generation]), {
                structuredContent: { layout: 'single', generations: [generation], allTerminal: generation.terminal },
            });
        },
    });
}
