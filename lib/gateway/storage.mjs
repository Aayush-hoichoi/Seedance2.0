// Persist generated images to the existing TOS bucket (same creds/bucket the
// video archive uses) so job rows store small keys, not megabytes of base64.
// Returns [{ key }] on success; falls back to inline b64 when TOS creds are
// absent (dev environments) rather than losing the result.

import { presignPutUrl, encodePath, TOS_ENDPOINT } from '../byteplus/tosSign.js';

const BUCKET = process.env.TOS_BUCKET?.trim() || 'seedance-studio-assets';

export function imageKeyForJob(jobId, index, mimeType = 'image/png') {
    const ext = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png';
    return `images/job-${jobId}-${index}.${ext}`;
}

export async function storeImages(jobId, images = []) {
    const ak = process.env.ARK_AK?.trim();
    const sk = process.env.ARK_SK?.trim();
    const host = `${BUCKET}.${TOS_ENDPOINT}`;
    const stored = [];
    for (let i = 0; i < images.length; i += 1) {
        const img = images[i];
        if (!img?.b64) { stored.push({ url: img?.url || null }); continue; }
        if (!ak || !sk) { stored.push({ b64: img.b64, mimeType: img.mimeType }); continue; }
        const key = imageKeyForJob(jobId, i, img.mimeType);
        try {
            const url = presignPutUrl({ host, path: `/${encodePath(key)}`, contentType: img.mimeType || 'image/png', ak, sk });
            const res = await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': img.mimeType || 'image/png' },
                body: Buffer.from(img.b64, 'base64'),
            });
            stored.push(res.ok ? { key } : { b64: img.b64, mimeType: img.mimeType });
        } catch {
            stored.push({ b64: img.b64, mimeType: img.mimeType });
        }
    }
    return stored;
}
