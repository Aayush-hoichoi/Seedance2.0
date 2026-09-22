import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { zipStream } from '../../../../lib/seedance/zip.mjs';
import { safeName } from '../../../../lib/seedance/downloadName.mjs';
import { ensureH264, remuxToMov, transcodeUrlToQuickTime } from '../../../../lib/seedance/ensureH264.mjs';
import { getUser } from '../../../../lib/auth/user.js';
import { getDb } from '../../../../lib/db/neon.js';
import { recordGenerationEvent } from '../../../../lib/access/db.js';

// Bulk-download finished generations (videos or images). POST { items: [{ url, name }] }.
//   • one item  → streams that asset back as an attachment (raw mp4/png/…)
//   • many items → streams a single .zip containing every asset
//
// The assets live behind presigned, cross-origin BytePlus links, so the browser
// can't save them itself: `<a download>` is ignored cross-origin (it just opens
// the file) and fetch+zip is blocked by CORS. The server has neither limit — it
// downloads each asset and streams it back as a real attachment. Memory stays
// flat — assets are pulled one at a time and piped through, never all at once.

export const runtime = 'nodejs';
export const maxDuration = 300;

const MAX_ITEMS = 200;
const MAX_ASSET_BYTES = 200 * 1024 * 1024; // mirrors the archive route's cap
const configuredMaxExrBytes = Number(process.env.BYTEPLUS_MAX_EXR_BYTES);
const MAX_EXR_BYTES = Number.isFinite(configuredMaxExrBytes) && configuredMaxExrBytes > 0 ? configuredMaxExrBytes : null;
// Only fetch from BytePlus's own media hosts — this is not an open proxy (SSRF).
const HOST_RE = /\.(volces\.com|bytepluses\.com|volcvideo\.com)$/;

function bad(message, status = 400) {
    return NextResponse.json({ error: message }, { status });
}

// Log a per-user download event for every item that carried a taskId. Records
// intent (the download was requested) — the actual byte transfer streams after.
// Wholly best-effort: unauthenticated calls, a missing DB, or a bad taskId just
// skip logging, never blocking the download itself.
async function logDownloads(items) {
    const tagged = items.filter((it) => it.taskId);
    if (!tagged.length) return;
    try {
        const user = await getUser().catch(() => null);
        const sql = await getDb();
        if (!sql) return;
        for (const it of tagged) {
            await recordGenerationEvent(sql, { taskId: it.taskId, userId: user?.userId ?? null, eventType: 'download' });
        }
    } catch {
        // never block a download on its analytics
    }
}

// Validate + normalize the requested items up front, so a bad input fails with a
// clean 400 *before* any bytes start streaming (headers can't change mid-stream).
function parseItems(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return { error: 'items must be a non-empty array.' };
    if (raw.length > MAX_ITEMS) return { error: `Too many items (max ${MAX_ITEMS}).` };
    const items = [];
    raw.forEach((it, i) => {
        const url = it && typeof it.url === 'string' ? it.url : null;
        if (!url) return;
        let parsed;
        try { parsed = new URL(url); } catch { return; }
        if (!HOST_RE.test(parsed.hostname)) return; // silently drop foreign hosts
        const taskId = it && typeof it.taskId === 'string' && it.taskId.length <= 200 ? it.taskId : null;
        items.push({ url, name: safeName(it.name, url, `asset-${i + 1}`), taskId });
    });
    if (!items.length) return { error: 'No downloadable BytePlus media URLs in the request.' };
    return { items };
}

function isExr(name, url) {
    return /\.exr(?:$|[?#])/i.test(name || '') || /\.exr(?:$|[?#])/i.test(url || '');
}

async function streamRawExr(item) {
    try {
        const res = await fetch(item.url);
        if (!res.ok || !res.body) return bad('Could not download the EXR file — the link may have expired.', 502);
        const length = Number(res.headers.get('content-length'));
        if (MAX_EXR_BYTES && Number.isFinite(length) && length > MAX_EXR_BYTES) {
            return bad(`The EXR file is larger than the configured ${Math.round(MAX_EXR_BYTES / 1024 / 1024)} MB download limit.`, 413);
        }
        const headers = {
            'Content-Type': 'image/x-exr',
            'Content-Disposition': contentDisposition(item.name),
            'Cache-Control': 'no-store',
        };
        if (Number.isFinite(length)) headers['Content-Length'] = String(length);
        return new Response(res.body, { headers });
    } catch {
        return bad('Could not download the EXR file — the link may have expired.', 502);
    }
}

async function streamQuickTime(item, request) {
    const conversion = transcodeUrlToQuickTime(item.url);
    if (!conversion) return bad('QuickTime conversion is not available on this server.', 503);
    request.signal?.addEventListener('abort', conversion.cancel, { once: true });
    const name = /\.(?:exr|mp4|m4v|mov)$/i.test(item.name) ? item.name.replace(/\.(?:exr|mp4|m4v|mov)$/i, '.mov') : `${item.name}.mov`;
    return new Response(Readable.toWeb(conversion.stream), {
        headers: {
            'Content-Type': 'video/quicktime',
            'Content-Disposition': contentDisposition(name),
            'Cache-Control': 'no-store',
        },
    });
}

// Download one asset into a Buffer, enforcing the size cap. Returns null on any
// failure so a single expired/broken link never aborts the whole archive.
async function fetchAsset(url, name = '') {
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const maxBytes = /\.exr$/i.test(name) || /\.exr(?:$|[?#])/i.test(url) ? MAX_EXR_BYTES : MAX_ASSET_BYTES;
        const len = Number(res.headers.get('content-length'));
        if (len && len > maxBytes) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        return buf.length && buf.length <= maxBytes ? buf : null;
    } catch {
        return null;
    }
}

export async function POST(request) {
    let body;
    try {
        body = await request.json();
    } catch {
        return bad('Body must be JSON.');
    }
    const { items, error } = parseItems(body?.items);
    if (error) return bad(error);
    // raw: skip the H.264 compatibility re-encode and the mov remux — return
    // the exact stored bytes (bit-identical original — 4k files stay H.265).
    const raw = body?.raw === true;
    const quickTime = body?.format === 'quicktime';
    // format: 'mp4' opts back into the plain mp4 (codec fix still applies —
    // only the mov rewrap is skipped). Anything else means the default, mov.
    const wantMov = body?.format !== 'mp4';

    // Videos leave as .mov by default: fix the codec if needed, then losslessly
    // rewrap the mp4 into a QuickTime container (editing tools prefer it). If
    // the remux fails for any reason the mp4 goes out unchanged.
    async function toDelivery(buf, name) {
        if (raw) return { data: buf, name };
        const fixed = await ensureH264(buf, name);
        if (!wantMov) return { data: fixed, name };
        const mov = await remuxToMov(fixed, name);
        return mov ? { data: mov, name: name.replace(/\.(mp4|m4v)$/i, '.mov') } : { data: fixed, name };
    }

    await logDownloads(items);

    // EXR results from BytePlus may be delivered as a MOV containing FFV1.
    // QuickTime cannot play FFV1, so provide a streamed H.264 MOV derivative
    // when the user asks for a QuickTime-compatible download.
    if (items.length === 1 && quickTime) {
        return streamQuickTime(items[0], request);
    }

    // EXR files can be larger than 1 GB. Stream the exact bytes through the
    // download endpoint instead of buffering the whole file in server memory.
    if (items.length === 1 && raw && isExr(items[0].name, items[0].url)) {
        return streamRawExr(items[0]);
    }

    // Single asset → buffer it (so the codec can be fixed) and send it back.
    if (items.length === 1) {
        const buf = await fetchAsset(items[0].url, items[0].name);
        if (!buf) {
            return bad('Could not download the file — the link may have expired.', 502);
        }
        const { data, name } = await toDelivery(buf, items[0].name);
        return new Response(data, {
            headers: {
                'Content-Type': contentTypeFor(name),
                'Content-Disposition': contentDisposition(name),
                'Cache-Control': 'no-store',
            },
        });
    }

    // Many assets → stream a zip. Fetch lazily as the archive is consumed.
    async function* entries() {
        for (const it of items) {
            const buf = await fetchAsset(it.url, it.name);
            if (buf) yield await toDelivery(buf, it.name);
        }
    }
    const nodeStream = Readable.from(zipStream(entries()));
    return new Response(Readable.toWeb(nodeStream), {
        headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': contentDisposition(zipName()),
            'Cache-Control': 'no-store',
        },
    });
}

const TYPES = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm', exr: 'image/x-exr', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
function contentTypeFor(name) {
    const ext = /\.(\w+)$/.exec(name || '')?.[1]?.toLowerCase();
    return TYPES[ext] || 'application/octet-stream';
}

// RFC 5987 / 6266 Content-Disposition with both a plain and a UTF-8 filename,
// so non-ASCII names survive the round-trip to the browser's Save dialog.
function contentDisposition(name) {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const encoded = encodeURIComponent(name);
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function zipName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `seedance-assets-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.zip`;
}
