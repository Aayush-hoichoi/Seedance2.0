// lib/mcp/tools/assets.js — list_assets, delete_asset, create_upload_url, register_asset.
import { z } from 'zod';
import { registerTool, toolGatewayCtx, ToolError } from '../register.js';
import { ensureUploadGroup, listAssets, getAsset, deleteAsset, createAsset, pollAssetActive } from '../../byteplus/assetsServer.js';
import { presignUpload } from '../../byteplus/uploadUrl.js';

export function registerAssetTools(server) {
    registerTool(server, {
        name: 'list_assets',
        description: 'Reference assets in a project’s asset pool (images/videos usable as generation refs).',
        schema: { projectId: z.number().int().positive() },
        run: async ({ user, args }) => {
            const { project } = await toolGatewayCtx(user, { projectId: args.projectId, permission: 'generation.create' });
            const groupId = await ensureUploadGroup(project);
            return { groupId, items: await listAssets(groupId, 'AIGC') };
        },
    });

    registerTool(server, {
        name: 'delete_asset',
        description: 'Delete an asset from a project’s pool. Only assets inside that project’s studio group.',
        schema: { projectId: z.number().int().positive(), assetId: z.string().min(1).max(64) },
        run: async ({ user, args }) => {
            const { project } = await toolGatewayCtx(user, { projectId: args.projectId, permission: 'generation.create' });
            const groupId = await ensureUploadGroup(project);
            const asset = await getAsset(args.assetId);
            if (String(asset.groupId) !== String(groupId)) {
                throw new ToolError('FORBIDDEN', 'That asset is not in this project’s pool.');
            }
            await deleteAsset(args.assetId);
            return { ok: true, deleted: args.assetId };
        },
    });

    registerTool(server, {
        name: 'create_upload_url',
        description: 'Presigned PUT URL for uploading a LOCAL file (from Claude Code: `curl -X PUT --upload-file <file> -H "Content-Type: <type>" "<putUrl>"`). Then call register_asset with the returned getUrl.',
        schema: {
            projectId: z.number().int().positive(),
            name: z.string().min(1).max(200),
            contentType: z.string().min(1).max(100),
        },
        run: async ({ user, args }) => {
            await toolGatewayCtx(user, { projectId: args.projectId, permission: 'generation.create' });
            const r = await presignUpload({ name: args.name, contentType: args.contentType });
            if (r.error) throw new ToolError('UPLOAD_UNAVAILABLE', r.error);
            return { ...r, next: 'PUT your file to putUrl, then call register_asset with url=getUrl.' };
        },
    });

    registerTool(server, {
        name: 'register_asset',
        description: 'Register a publicly reachable image/video URL into the project’s asset pool. Waits for verification (~10-30s). The returned asset id works as a ref in create_video / create_image.',
        schema: {
            projectId: z.number().int().positive(),
            url: z.string().url().max(3000),
            kind: z.enum(['image', 'video']),
            name: z.string().max(64).optional(),
        },
        run: async ({ user, args }) => {
            const { project } = await toolGatewayCtx(user, { projectId: args.projectId, permission: 'generation.create' });
            const groupId = await ensureUploadGroup(project);
            const assetId = await createAsset({ groupId, url: args.url, kind: args.kind, name: args.name });
            try {
                const asset = await pollAssetActive(assetId, { intervalMs: 3000, maxAttempts: 60, deadlineMs: Date.now() + 210_000 });
                return { assetId, status: asset.status, name: asset.name, previewUrl: asset.previewUrl };
            } catch (err) {
                if (err.code === 'STILL_PROCESSING') {
                    return { assetId, status: 'Processing', note: 'Still verifying — check list_assets in ~30s; the asset id is already valid once Active.' };
                }
                throw err;
            }
        },
    });
}
