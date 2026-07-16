// lib/mcp/tools/generate.js — create_video, create_image (+ get_job_status/
// cancel_job land here in Task 11).
import { after } from 'next/server';
import { registerTool, ToolError } from '../register.js';
import { createVideoShape, createImageShape } from '../schemas.mjs';
import { buildVideoContent } from '../videoContent.mjs';
import { createVideoTask } from '../../gateway/videoCreate.mjs';
import { enqueueGeneration } from '../../gateway/enqueue.mjs';
import { processQueue } from '../../gateway/processor.mjs';
import { getAsset } from '../../byteplus/assetsServer.js';

// next/server's after() needs a live request scope. It works inside this MCP
// route's own POST handler (the tool run() call is still part of that request's
// async chain), but if that assumption ever breaks, fall back to firing the
// kick directly rather than losing the queue nudge entirely.
function kickQueue() {
    try {
        after(() => processQueue().catch(() => {}));
    } catch {
        processQueue().catch(() => {});
    }
}

// assetId refs → { url, role } via the asset library's preview URL.
async function resolveRefs(refs = []) {
    return Promise.all(refs.map(async (r) => {
        if (r.url) return { url: r.url, role: r.role };
        if (!r.assetId) throw new ToolError('BAD_REQUEST', 'Each ref needs an assetId or a url.');
        const asset = await getAsset(r.assetId);
        if (asset.status !== 'Active' || !asset.previewUrl) throw new ToolError('BAD_REQUEST', `Asset ${r.assetId} is not ready (status ${asset.status}).`);
        return { url: asset.previewUrl, role: r.role };
    }));
}

// Reference images for the image models must be inlined base64 (the studio
// downscales client-side; here we fetch server-side). Shape matches
// sanitizeImageRequest (lib/gateway/validateImageRequest.mjs): flat
// { inlineData: { mimeType, data } } parts, no data: prefix. Caps mirror the
// same file: ≤3 refs, ~4MB base64 total.
async function fetchRefsAsParts(refs = []) {
    const resolved = await resolveRefs(refs);
    const parts = [];
    let total = 0;
    for (const r of resolved) {
        const res = await fetch(r.url);
        if (!res.ok) throw new ToolError('BAD_REQUEST', `Could not fetch ref ${r.url} (${res.status}).`);
        const mime = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
        if (!mime.startsWith('image/')) throw new ToolError('BAD_REQUEST', 'Image refs must be images.');
        const b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
        total += b64.length;
        if (total > 4 * 1024 * 1024) throw new ToolError('BAD_REQUEST', 'Reference images exceed the 4MB total cap — use smaller images.');
        parts.push({ inlineData: { mimeType: mime, data: b64 } });
    }
    return parts;
}

export function registerGenerateTools(server) {
    registerTool(server, {
        name: 'create_video',
        description: 'Generate a video (Seedance family). Returns taskId + jobId — poll with get_job_status. Costs real money; quotas and model grants apply.',
        schema: createVideoShape,
        run: async ({ user, args }) => {
            const refs = await resolveRefs(args.refs);
            const request = {
                model: args.model,
                content: buildVideoContent({ prompt: args.prompt, refs }),
                ...(args.resolution ? { resolution: args.resolution } : {}),
                ...(args.duration ? { duration: args.duration } : {}),
                ...(args.ratio ? { ratio: args.ratio } : {}),
            };
            const result = await createVideoTask({ user, projectId: args.projectId ?? null, mode: args.mode ?? null, request });
            if (result.status >= 400) throw new ToolError(result.body?.code ?? 'CREATE_FAILED', result.body?.error ?? result.body?.message ?? 'Video create failed.');
            return { taskId: result.body.id, jobId: result.body.jobId ?? null, poll: 'get_job_status with this taskId' };
        },
    });

    registerTool(server, {
        name: 'create_image',
        description: 'Generate image(s) (Nano Banana 2/Pro, Seedream 5.0 Pro). Returns generationId — poll with get_job_status. Quotas and model grants apply.',
        schema: createImageShape,
        run: async ({ user, args }) => {
            const parts = args.refs?.length ? await fetchRefsAsParts(args.refs) : null;
            const result = await enqueueGeneration({
                user,
                projectId: args.projectId,
                modelId: args.model,
                request: { prompt: args.prompt, ...(parts ? { parts } : {}) },
                options: {
                    ...(args.imageCount ? { imageCount: args.imageCount } : {}),
                    ...(args.aspectRatio ? { aspectRatio: args.aspectRatio } : {}),
                    ...(args.imageSize ? { imageSize: args.imageSize } : {}),
                },
            });
            if (result.status >= 400) throw new ToolError(result.body?.code ?? 'CREATE_FAILED', result.body?.message ?? 'Image create failed.');
            if (result.enqueued) kickQueue();
            return result.body; // { generationId, status: 'queued', estCostUsd }
        },
    });
}
