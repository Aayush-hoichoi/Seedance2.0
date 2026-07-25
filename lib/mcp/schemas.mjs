// lib/mcp/schemas.mjs — zod raw shapes + the tool → permission map.
// Pure module: node --test runs it directly.
import { z } from 'zod';

export const REF_ROLES = ['first_frame', 'last_frame', 'reference_image', 'reference_video'];

export const refsShape = {
    assetId: z.string().max(64).optional(),
    url: z.string().url().max(2000).optional(),
    role: z.enum(REF_ROLES),
};

export const createVideoShape = {
    projectId: z.number().int().positive().optional(),
    model: z.string().min(1).max(100),
    prompt: z.string().min(1).max(5000),
    mode: z.string().max(50).optional(),
    resolution: z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase() : v),
        z.enum(['480p', '720p', '1080p', '4k'])).optional(),
    duration: z.number().int().min(1).max(30).optional(),
    ratio: z.string().max(10).optional(),
    refs: z.array(z.object(refsShape)).max(4).optional(),
};

export const createImageShape = {
    projectId: z.number().int().positive(),
    model: z.string().min(1).max(100),
    prompt: z.string().min(1).max(5000),
    imageCount: z.number().int().min(1).max(4).optional(),
    aspectRatio: z.string().max(10).optional(),
    imageSize: z.enum(['1K', '2K', '4K']).optional(),
    // Outer bound only — the per-model cap (Nano Banana Pro 14, Flash 3) is
    // enforced server-side by sanitizeImageRequest(imageRefMax(modelId)).
    refs: z.array(z.object(refsShape)).max(14).optional(),
};

// Tool → gateway permission. null = any signed-in user (membership still scopes data).
export const TOOL_PERMISSIONS = {
    ping: null,
    list_models: null, get_my_access: null, request_model_access: null,
    list_projects: null,
    // create_project/update_project: role-gated per-branch inside the tool (console POST/PATCH/DELETE parity)
    create_project: null, update_project: null,
    list_generations: null, get_generation: null, browse_gallery: null,
    bin_generation: null, like_generation: null,
    list_assets: 'generation.create', delete_asset: 'generation.create',
    register_asset: 'generation.create', create_upload_url: 'generation.create',
    create_video: 'generation.create', create_image: 'generation.create',
    get_job_status: null, cancel_job: null,
    get_usage: 'usage.view',
    list_access_requests: 'model.grant', resolve_access_request: 'model.grant',
    list_quotas: 'quota.manage', set_quota: 'quota.manage',
    view_audit: 'audit.view',
};
