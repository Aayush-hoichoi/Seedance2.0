import { archiveKeyForTask } from '../seedance/archiveKey.mjs';
import { presignKey } from '../seedance/galleryItem.mjs';

export const MEDIA_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
export const TERMINAL_GENERATION_STATUSES = new Set([
    'succeeded',
    'failed',
    'timed_out',
    'cancelled',
]);

function iso(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function extensionForMime(mimeType, fallback = 'bin') {
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/webp') return 'webp';
    if (mimeType === 'image/gif') return 'gif';
    if (mimeType === 'image/png') return 'png';
    if (mimeType === 'video/webm') return 'webm';
    if (mimeType === 'video/mp4') return 'mp4';
    return fallback;
}

function mimeFromImage(image) {
    if (image?.mimeType?.startsWith('image/')) return image.mimeType;
    const value = String(image?.key || image?.url || '').split(/[?#]/)[0].toLowerCase();
    if (value.endsWith('.jpg') || value.endsWith('.jpeg')) return 'image/jpeg';
    if (value.endsWith('.webp')) return 'image/webp';
    if (value.endsWith('.gif')) return 'image/gif';
    return 'image/png';
}

function signedMediaUrl(key, { signKey, now, urlTtlSeconds }) {
    if (!key) return null;
    const url = signKey(key, { expiresSec: urlTtlSeconds, date: now });
    if (!url) return null;
    return {
        url,
        expiresAt: new Date(now.getTime() + urlTtlSeconds * 1000).toISOString(),
    };
}

function imageMedia(job, { signKey, now, urlTtlSeconds }) {
    const images = Array.isArray(job.result?.images) ? job.result.images : [];
    return images.flatMap((image, index) => {
        const mimeType = mimeFromImage(image);
        const signed = image?.key
            ? signedMediaUrl(image.key, { signKey, now, urlTtlSeconds })
            : null;
        const url = signed?.url
            || image?.url
            || (image?.b64 ? `data:${mimeType};base64,${image.b64}` : null);
        if (!url) return [];
        return [{
            id: `${job.id}-image-${index + 1}`,
            type: 'image',
            url,
            mimeType,
            filename: `generation-${job.id}-${index + 1}.${extensionForMime(mimeType, 'png')}`,
            source: signed ? 'archive' : image?.b64 ? 'inline' : 'provider',
            expiresAt: signed?.expiresAt ?? null,
        }];
    });
}

function videoMedia(job, { signKey, now, urlTtlSeconds }) {
    // Never hand the widget a provider video URL: those links normally expire
    // within a day. Completed gateway videos are archived under a stable TOS
    // key and are signed again on every MCP tool call.
    const key = job.result?.video_key || archiveKeyForTask(job.provider_task_id);
    const signed = signedMediaUrl(key, { signKey, now, urlTtlSeconds });
    if (!signed) return [];
    return [{
        id: `${job.id}-video-1`,
        type: 'video',
        url: signed.url,
        mimeType: 'video/mp4',
        filename: `generation-${job.id}.mp4`,
        source: 'archive',
        expiresAt: signed.expiresAt,
    }];
}

export function isTerminalGenerationStatus(status) {
    return TERMINAL_GENERATION_STATUSES.has(status);
}

export function normalizeGeneration(job, {
    signKey = presignKey,
    now = new Date(),
    urlTtlSeconds = MEDIA_URL_TTL_SECONDS,
} = {}) {
    const category = job.request_body?.category === 'image' ? 'image' : 'video';
    const terminal = isTerminalGenerationStatus(job.status);
    const media = job.status === 'succeeded'
        ? (category === 'image'
            ? imageMedia(job, { signKey, now, urlTtlSeconds })
            : videoMedia(job, { signKey, now, urlTtlSeconds }))
        : [];

    return {
        generationId: Number(job.id),
        status: job.status,
        terminal,
        category,
        modelId: job.model_id ?? null,
        projectId: job.project_id ?? null,
        providerTaskId: job.provider_task_id ?? null,
        createdAt: iso(job.created_at),
        finishedAt: iso(job.finished_at),
        error: job.error ?? null,
        media,
        pollAfterMs: terminal ? null : 3000,
    };
}

export function fallbackContentForGenerations(generations) {
    const lines = [];
    for (const generation of generations) {
        lines.push(`Generation ${generation.generationId}: ${generation.status}`);
        for (const media of generation.media) {
            if (media.type === 'video') {
                lines.push(`[Watch video ${generation.generationId}](${media.url})`);
            } else {
                lines.push(`[Open image ${generation.generationId}](${media.url})`);
            }
        }
    }
    return [{ type: 'text', text: lines.join('\n\n') || 'No generations.' }];
}
