// Extracted from app/api/gallery/route.js — one DB row → the item shape the
// gallery/liked clients render, plus the TOS presign helper it depends on.
// Kept here (not in the route) so it can be reused by MCP tools without
// pulling in next/server.

import { presignGetUrl, encodePath, TOS_ENDPOINT } from '../byteplus/tosSign.js';
import { archiveKeyForTask } from './archiveKey.mjs';
import { MODELS } from './constants.js';

const BUCKET = process.env.TOS_BUCKET?.trim() || 'seedance-studio-assets';

// Presign a 7-day GET for any TOS object key (pure local HMAC, no round-trip).
// Videos are archived under videos/<taskId>.mp4; images under the job-scoped
// images/job-<id>-<index>.<ext> key the gateway stored on the job result.
export function presignKey(key, { expiresSec = 604800, date = new Date() } = {}) {
    const ak = process.env.ARK_AK?.trim();
    const sk = process.env.ARK_SK?.trim();
    if (!ak || !sk || !key) return null;
    const host = `${BUCKET}.${TOS_ENDPOINT}`;
    return presignGetUrl({ host, path: `/${encodePath(key)}`, ak, sk, expiresSec, date });
}

// Presigned view URLs for an image job's stored result ({ images: [{ key } |
// { url } | { b64, mimeType }] } per lib/gateway/storage.mjs). b64 dev-fallback
// entries have no URL to give and are skipped.
export function imageUrlsFromResult(result) {
    const images = Array.isArray(result?.images) ? result.images : [];
    return images.map((im) => im?.url || (im?.key ? presignKey(im.key) : null)).filter(Boolean);
}

// One DB row → the item shape the gallery/liked clients render. Images carry no
// seedance_prompts row, so their prompt comes off the job's request body
// (image_prompt) and their media URL is the presigned first stored image.
export function toItem(r) {
    const isImage = r.category === 'image';
    return {
        taskId: r.task_id,
        mediaType: isImage ? 'image' : 'video',
        modelId: r.model_id,
        modelName: MODELS.find((m) => m.id === r.model_id)?.name ?? r.model_id ?? 'Seedance',
        resolution: r.resolution,
        duration: r.duration,
        ratio: r.ratio,
        mode: r.mode,
        status: r.status,
        createdAt: r.created_at,
        prompt: r.generated_prompt || r.user_prompt || r.image_prompt || '',
        userPrompt: r.user_prompt || r.image_prompt || null,
        style: r.style || null,
        refs: Array.isArray(r.refs) && r.refs.length ? r.refs : null,
        liked: !!r.liked,
        projectId: r.project_id ?? null,
        archiveUrl: isImage ? null : presignKey(archiveKeyForTask(r.task_id)),
        imageUrl: isImage ? presignKey(r.image_key) : null,
    };
}
