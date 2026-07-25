// Server-only. Download a finished ModelArk video and PUT it to
// videos/<taskId>.mp4 in TOS so it outlives the provider's ~24h signed URL.
// This is the server-side twin of POST /api/byteplus/archive — the route wraps
// it (adds a fresh presigned URL for the browser), and the queue processor calls
// it at settle so EVERY video is captured regardless of whether a tab stayed
// open. NEVER import into client code: it reads the secret access key.

import { signTosRequest, encodePath, TOS_ENDPOINT } from '../byteplus/tosSign.js';
import { archiveKeyForTask } from './archiveKey.mjs';

const BUCKET = process.env.TOS_BUCKET?.trim() || 'seedance-studio-assets';
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
// Only fetch from BytePlus's own media hosts — this is not an open proxy (SSRF).
const HOST_RE = /\.(volces\.com|bytepluses\.com)$/;

// Errors carry `.httpStatus` so the HTTP route can map them to the same status
// codes it returned before this was extracted; other callers can ignore it.
function fail(message, httpStatus) {
    const err = new Error(message);
    err.httpStatus = httpStatus;
    return err;
}

// Download `url` → PUT to videos/<taskId>.mp4. Returns { key } on success,
// throws on any failure (callers decide whether to swallow). Idempotent: the
// key is deterministic in taskId, so a re-run just overwrites the same object.
export async function archiveVideo({ url, taskId }) {
    const ak = process.env.ARK_AK?.trim();
    const sk = process.env.ARK_SK?.trim();
    if (!ak || !sk) throw fail('ARK_AK / ARK_SK are not configured.', 500);
    if (!url || !taskId) throw fail('url and taskId are required.', 400);

    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw fail('url is not a valid URL.', 400);
    }
    if (!HOST_RE.test(parsed.hostname)) throw fail('url must be a BytePlus media URL.', 400);

    const upstream = await fetch(url);
    if (!upstream.ok) throw fail(`Could not download the video (${upstream.status}) — the link may have expired.`, 502);
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_VIDEO_BYTES) throw fail('Video too large to archive.', 413);

    const host = `${BUCKET}.${TOS_ENDPOINT}`;
    const key = archiveKeyForTask(taskId);
    const path = `/${encodePath(key)}`;
    const headers = signTosRequest({
        method: 'PUT', host, path,
        ak, sk,
        extraHeaders: { 'content-type': 'video/mp4' },
    });
    const put = await fetch(`https://${host}${path}`, { method: 'PUT', headers, body: buf });
    if (!put.ok) {
        const text = await put.text().catch(() => '');
        throw fail(`Archive upload failed (${put.status}): ${text.slice(0, 200)}`, 502);
    }
    return { key };
}
