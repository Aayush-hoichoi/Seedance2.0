// Persist generated images to the existing TOS bucket (same creds/bucket the
// video archive uses) so job rows store small keys, not megabytes of base64.
// Returns [{ key }] on success; falls back to inline b64 rather than losing a
// generation the user already paid for.
//
// Two very different situations reach that same fallback, so they are NOT
// reported the same way:
//   • no ARK_AK/ARK_SK at all — the documented dev path. Expected, stays quiet.
//   • credentials present but TOS refused — an incident. Every generation from
//     that moment silently writes megabytes of base64 into Postgres instead of
//     a key, and the only visible symptom is a slowly fattening table. This
//     went unnoticed for two days in Aug 2026 after the TOS access key was
//     rotated; it is logged now, like the video archive beside it in
//     processor.mjs settleSuccess().

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
            if (res.ok) { stored.push({ key }); continue; }
            // Name the bucket: the usual cause is a wrong ARK_AK/ARK_SK or an
            // unset TOS_BUCKET pointing at a bucket this account cannot write.
            const detail = await res.text().catch(() => '');
            console.error(`[storage] job ${jobId} image ${i}: PUT ${key} to ${BUCKET} failed (${res.status}) — `
                + `falling back to inline base64: ${detail.slice(0, 200)}`);
        } catch (err) {
            console.error(`[storage] job ${jobId} image ${i}: PUT ${key} to ${BUCKET} threw — `
                + `falling back to inline base64: ${err.message}`);
        }
        stored.push({ b64: img.b64, mimeType: img.mimeType });
    }
    return stored;
}
