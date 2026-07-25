import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { zipStream } from '../../../../lib/seedance/zip.mjs';
import { safeName } from '../../../../lib/seedance/downloadName.mjs';
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
// Only fetch from BytePlus's own media hosts — this is not an open proxy (SSRF).
const HOST_RE = /\.(volces\.com|bytepluses\.com)$/;

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

// Download one asset into a Buffer, enforcing the size cap. Returns null on any
// failure so a single expired/broken link never aborts the whole archive.
async function fetchAsset(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const len = Number(res.headers.get('content-length'));
        if (len && len > MAX_ASSET_BYTES) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        return buf.length && buf.length <= MAX_ASSET_BYTES ? buf : null;
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

    await logDownloads(items);

    // Single asset → stream the raw file straight through (no zip overhead).
    if (items.length === 1) {
        const res = await fetch(items[0].url).catch(() => null);
        if (!res || !res.ok || !res.body) {
            return bad('Could not download the file — the link may have expired.', 502);
        }
        return new Response(res.body, {
            headers: {
                // Mirror what the origin served (image/png, video/mp4, …) rather than
                // asserting a type; the attachment disposition is what forces the save.
                'Content-Type': res.headers.get('content-type') || 'application/octet-stream',
                'Content-Disposition': contentDisposition(items[0].name),
                'Cache-Control': 'no-store',
            },
        });
    }

    // Many assets → stream a zip. Fetch lazily as the archive is consumed.
    async function* entries() {
        for (const it of items) {
            const data = await fetchAsset(it.url);
            if (data) yield { name: it.name, data };
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
