// Server-only durable copy for a completed EXR output.

import { signTosRequest, presignGetUrl, encodePath, TOS_ENDPOINT } from './tosSign.js';

const BUCKET = process.env.TOS_BUCKET?.trim() || 'seedance-studio-assets';
const MAX_BYTES = Number(process.env.BYTEPLUS_MAX_EXR_BYTES) || 1024 * 1024 * 1024;
const HOST_RE = /\.(volces\.com|bytepluses\.com|volcvideo\.com|byteplusvod\.com)$/i;

export async function archiveExr({ url, taskId }) {
    const ak = process.env.ARK_AK?.trim();
    const sk = process.env.ARK_SK?.trim();
    if (!ak || !sk) return { key: null, url, durable: false };
    if (!url || !taskId) throw new Error('url and taskId are required.');
    const parsed = new URL(url);
    if (!HOST_RE.test(parsed.hostname)) throw new Error('EXR source URL is not a trusted BytePlus media URL.');
    const upstream = await fetch(url);
    if (!upstream.ok) throw new Error(`Could not download the EXR output (${upstream.status}).`);
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (!bytes.length) throw new Error('BytePlus returned an empty EXR output.');
    if (bytes.length > MAX_BYTES) throw new Error(`EXR output is larger than ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`);

    const safeId = String(taskId).replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `exr/${safeId}.exr`;
    const host = `${BUCKET}.${TOS_ENDPOINT}`;
    const path = `/${encodePath(key)}`;
    const headers = signTosRequest({ method: 'PUT', host, path, ak, sk, extraHeaders: { 'content-type': 'image/x-exr' } });
    const put = await fetch(`https://${host}${path}`, { method: 'PUT', headers, body: bytes });
    if (!put.ok) {
        return {
            key: null,
            url,
            durable: false,
            bytes: bytes.length,
            archiveError: `EXR archive upload failed (${put.status}).`,
        };
    }
    return { key, url: presignGetUrl({ host, path, ak, sk, expiresSec: 604800 }), durable: true, bytes: bytes.length, archiveError: null };
}
