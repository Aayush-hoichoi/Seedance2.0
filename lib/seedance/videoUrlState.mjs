import { tosPresignExpired } from './tosPresign.mjs';

const STALE_PROVIDER_URL_MS = 20 * 60 * 60 * 1000;

export function isStudioVideoUrlStale(job, now = Date.now()) {
    if (!job?.videoUrl || job.expired) return true;
    if (tosPresignExpired(job.videoUrl, now)) return true;
    // TOS and CloudFront URLs carry the origin's signing clock. A fresh
    // signature is usable even when the generation itself is months old.
    try {
        const params = new URL(job.videoUrl).searchParams;
        if (params.has('X-Tos-Date') && params.has('X-Tos-Expires')) return false;
    } catch { /* older cache entries may not contain a complete URL */ }
    // Provider links have no common signing clock. Keep the conservative
    // age fallback, even if an archive key exists alongside a provider URL.
    return now - (job.urlRefreshedAt || job.createdAt || 0) > STALE_PROVIDER_URL_MS;
}
