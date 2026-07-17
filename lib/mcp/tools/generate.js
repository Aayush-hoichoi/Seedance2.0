// lib/mcp/tools/generate.js — create_video, create_image, get_job_status,
// cancel_job.
import { after } from 'next/server';
import { z } from 'zod';
import { registerTool, toolGatewayCtx, ToolError } from '../register.js';
import { createVideoShape, createImageShape } from '../schemas.mjs';
import { assertPublicHttpUrl } from '../urlGuard.mjs';
import { buildVideoContent } from '../videoContent.mjs';
import { createVideoTask } from '../../gateway/videoCreate.mjs';
import { enqueueGeneration } from '../../gateway/enqueue.mjs';
import { processQueue } from '../../gateway/processor.mjs';
import { getAsset } from '../../byteplus/assetsServer.js';
import { getJob } from '../../gateway/db.js';
import { cancelJob } from '../../gateway/cancel.mjs';
import { sweep } from '../../gateway/sweep.mjs';
import { presignKey } from '../../seedance/galleryItem.mjs';
import { archiveKeyForTask } from '../../seedance/archiveKey.mjs';

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

const MAX_REF_BYTES = 4 * 1024 * 1024;
const REF_CAP_MESSAGE = 'Reference images exceed the 4MB total cap — use smaller images.';

// Reference images for the image models must be inlined base64 (the studio
// downscales client-side; here we fetch server-side). Shape matches
// sanitizeImageRequest (lib/gateway/validateImageRequest.mjs): flat
// { inlineData: { mimeType, data } } parts, no data: prefix. Caps mirror the
// same file: ≤3 refs, ~4MB total.
//
// These URLs are user-supplied and fetched by the server (SSRF surface), so
// each one is checked against assertPublicHttpUrl before the request goes
// out, and the read is streamed with a running byte cap instead of buffering
// a potentially huge body in full before checking size.
async function fetchRefsAsParts(refs = []) {
    const resolved = await resolveRefs(refs);
    const parts = [];
    let total = 0;
    for (const r of resolved) {
        try {
            assertPublicHttpUrl(r.url);
        } catch {
            throw new ToolError('BAD_REQUEST', 'Reference URLs must be public http(s) addresses.');
        }

        let res;
        try {
            res = await fetch(r.url);
        } catch {
            throw new ToolError('BAD_REQUEST', 'Could not fetch a reference image URL.');
        }
        if (!res.ok) throw new ToolError('BAD_REQUEST', 'Could not fetch a reference image URL.');
        const mime = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
        if (!mime.startsWith('image/')) throw new ToolError('BAD_REQUEST', 'Image refs must be images.');

        const declaredLength = Number(res.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > 0 && total + declaredLength > MAX_REF_BYTES) {
            throw new ToolError('BAD_REQUEST', REF_CAP_MESSAGE);
        }

        const chunks = [];
        let bytes = 0;
        const reader = res.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            total += value.byteLength;
            if (total > MAX_REF_BYTES) {
                await reader.cancel().catch(() => {});
                throw new ToolError('BAD_REQUEST', REF_CAP_MESSAGE);
            }
            chunks.push(value);
        }
        const data = Buffer.concat(chunks.map((c) => Buffer.from(c)), bytes).toString('base64');
        parts.push({ inlineData: { mimeType: mime, data } });
    }
    return parts;
}

export function registerGenerateTools(server) {
    registerTool(server, {
        name: 'create_video',
        description: 'Generate a video (Seedance family). Returns taskId + jobId — poll with get_job_status. Costs real money; quotas and model grants apply.',
        schema: createVideoShape,
        run: async ({ user, args }) => {
            // TOOL_PERMISSIONS (lib/mcp/schemas.mjs) documents create_video as
            // generation.create — enforce it here explicitly. createVideoTask's
            // own resolveGateway only checks membership/model-access/quota, not
            // this permission, so without this call a member with no
            // generation.create grant could still reach the provider.
            // gatewayContextFor runs its permission check regardless of whether
            // projectId is null (verified in lib/gateway/authz.js) — a null
            // project just skips the membership check, not the permission one.
            await toolGatewayCtx(user, args.projectId ? { projectId: args.projectId, permission: 'generation.create' } : { permission: 'generation.create' });
            const refs = await resolveRefs(args.refs);
            const request = {
                model: args.model,
                content: buildVideoContent({ prompt: args.prompt, refs }),
                ...(args.resolution ? { resolution: args.resolution } : {}),
                ...(args.duration ? { duration: args.duration } : {}),
                ...(args.ratio ? { ratio: args.ratio } : {}),
            };
            const result = await createVideoTask({ user, projectId: args.projectId ?? null, mode: args.mode ?? null, request });
            if (result.status >= 400) {
                throw new ToolError(
                    result.body?.code ?? result.body?.error?.code ?? 'CREATE_FAILED',
                    result.body?.error?.message ?? result.body?.error ?? result.body?.message ?? 'Video create failed.',
                );
            }
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

    registerTool(server, {
        name: 'get_job_status',
        description: 'Status of a generation. Pass generationId (gateway id from create_image / jobId from create_video) OR taskId (ModelArk id from create_video). Finished videos include a playable URL.',
        schema: {
            generationId: z.number().int().positive().optional(),
            taskId: z.string().min(1).max(200).optional(),
        },
        run: async ({ user, args }) => {
            if (args.generationId) {
                sweep().catch(() => {}); // status polls drive queue maintenance (no cron on Hobby)
                const { sql } = await toolGatewayCtx(user, {});
                const job = await getJob(sql, args.generationId);
                if (!job) throw new ToolError('NOT_FOUND', 'Generation not found.');
                if (job.user_id !== user.userId) await toolGatewayCtx(user, { projectId: job.project_id, permission: 'usage.view' });
                // Prompt privacy does not apply here — this shape only ever
                // exposes status/error/result/URLs, never request_body.
                const isVideo = (job.request_body?.category ?? 'video') === 'video';
                return {
                    generationId: job.id, status: job.status, error: job.error ?? null,
                    result: job.result ?? null, providerTaskId: job.provider_task_id ?? null,
                    videoUrl: isVideo && job.provider_task_id ? presignKey(archiveKeyForTask(job.provider_task_id)) : null,
                };
            }
            if (!args.taskId) throw new ToolError('BAD_REQUEST', 'Pass generationId or taskId.');
            const key = process.env.ARK_API_KEY;
            if (!key) throw new ToolError('CONFIG', 'ARK_API_KEY is not configured.');
            const res = await fetch(`https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks/${encodeURIComponent(args.taskId)}`, {
                headers: { Authorization: `Bearer ${key}` },
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new ToolError('PROVIDER_ERROR', data?.error?.message ?? `Provider returned ${res.status}.`);
            return {
                taskId: args.taskId, status: data?.status ?? 'unknown',
                // content.video_url matches ModelArk's terminal task shape —
                // see lib/seedance/client.js pollTask() and
                // app/seedance/SeedanceStudio.jsx (both read data.content.video_url).
                // Our own archived copy is the fallback (may outlive the
                // provider's own URL, same as get_generation's archiveUrl).
                videoUrl: data?.content?.video_url ?? presignKey(archiveKeyForTask(args.taskId)),
                raw: data,
            };
        },
    });

    registerTool(server, {
        name: 'cancel_job',
        description: 'Cancel a queued/running generation by gateway generationId. Creators cancel their own; managers/admins can cancel any in their reach.',
        schema: { generationId: z.number().int().positive() },
        run: async ({ user, args }) => {
            const { sql } = await toolGatewayCtx(user, {});
            const job = await getJob(sql, args.generationId);
            if (!job) throw new ToolError('NOT_FOUND', 'Generation not found.');
            const own = job.user_id === user.userId;
            if (!own) {
                const scoped = await toolGatewayCtx(user, { projectId: job.project_id, permission: 'usage.view' });
                if (scoped.role !== 'admin' && scoped.role !== 'manager') {
                    throw new ToolError('FORBIDDEN', 'Only the creator or a manager can cancel this generation.');
                }
            }
            const cancelled = await cancelJob(sql, job, { reason: own ? 'cancelled by creator (MCP)' : 'cancelled by admin (MCP)' });
            if (!cancelled) throw new ToolError('BAD_REQUEST', 'Generation already finished.');
            return { ok: true, status: 'cancelled' };
        },
    });
}
