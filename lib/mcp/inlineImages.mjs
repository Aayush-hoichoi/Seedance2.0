// Fetch a finished image job's stored outputs (trusted keys from
// lib/gateway/storage.mjs on our own TOS bucket — never user URLs) and return
// MCP image content blocks so the picture renders directly in the chat.
// Budgeted to ~3MB of fetched bytes; anything skipped still reaches the
// client via the payload's imageUrls.
import { presignKey } from '../seedance/galleryItem.mjs';

const INLINE_IMAGE_BUDGET = 3 * 1024 * 1024;

export async function inlineImageBlocks(result) {
    const blocks = [];
    let budget = INLINE_IMAGE_BUDGET;
    const images = Array.isArray(result?.images) ? result.images : [];
    for (const im of images) {
        if (im?.b64) { // dev fallback: already inline
            blocks.push({ type: 'image', data: im.b64, mimeType: im.mimeType || 'image/png' });
            continue;
        }
        const url = im?.url || (im?.key ? presignKey(im.key) : null);
        if (!url) continue;
        try {
            const res = await fetch(url);
            if (!res.ok) continue;
            const mime = res.headers.get('content-type')?.split(';')[0] || 'image/png';
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > budget) continue;
            budget -= buf.length;
            blocks.push({ type: 'image', data: buf.toString('base64'), mimeType: mime });
        } catch { /* imageUrls in the payload remain the fallback */ }
    }
    return blocks;
}
