// lib/mcp/tools/assets.js — list_assets, delete_asset (+ Task 8 adds uploads).
import { z } from 'zod';
import { registerTool, toolGatewayCtx, ToolError } from '../register.js';
import { ensureUploadGroup, listAssets, getAsset, deleteAsset, createAsset, pollAssetActive } from '../../byteplus/assetsServer.js';

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
}
