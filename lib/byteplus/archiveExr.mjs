// Server-only durable copy for a completed EXR output.

import { signTosRequest, presignGetUrl, encodePath, TOS_ENDPOINT } from './tosSign.js';

const BUCKET = process.env.TOS_BUCKET?.trim() || 'seedance-studio-assets';
const configuredMaxBytes = Number(process.env.BYTEPLUS_MAX_EXR_BYTES);
const MAX_BYTES = Number.isFinite(configuredMaxBytes) && configuredMaxBytes > 0 ? configuredMaxBytes : null;
const HOST_RE = /\.(volces\.com|bytepluses\.com|volcvideo\.com|byteplusvod\.com)$/i;

function archiveLimitMessage() {
    return `EXR output is larger than ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`;
}

function uploadErrorMessage(status, body) {
    let code = null;
    try { code = JSON.parse(body || '{}')?.Code || null; } catch { /* keep the status-only message */ }
    if (code === 'InvalidAccessKeyId') return 'TOS rejected ARK_AK. Add an active TOS HMAC access-key pair to ARK_AK and ARK_SK.';
    if (code === 'SignatureDoesNotMatch') return 'TOS rejected the signature. ARK_AK and ARK_SK are not a matching TOS HMAC pair.';
    return `EXR archive upload failed (${status}).`;
}

// `key` / `contentType` let the upscale tool reuse this for its MP4/MOV output.
export async function archiveExr({ url, taskId, key: keyOverride = null, contentType = 'image/x-exr' }) {
    const ak = process.env.ARK_AK?.trim();
    const sk = process.env.ARK_SK?.trim();
    if (!ak || !sk) return {
        key: null,
        url,
        durable: false,
        archiveError: 'TOS storage is not configured. Add ARK_AK and ARK_SK with an active TOS HMAC access-key pair.',
    };
    if (!url || !taskId) throw new Error('url and taskId are required.');
    const parsed = new URL(url);
    if (!HOST_RE.test(parsed.hostname)) throw new Error('EXR source URL is not a trusted BytePlus media URL.');
    const upstream = await fetch(url);
    if (!upstream.ok) throw new Error(`Could not download the EXR output (${upstream.status}).`);
    const contentLength = Number(upstream.headers.get('content-length'));
    if (MAX_BYTES && Number.isFinite(contentLength) && contentLength > MAX_BYTES) throw new Error(archiveLimitMessage());
    if (!upstream.body) throw new Error('BytePlus returned an empty EXR output.');

    const safeId = String(taskId).replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = keyOverride || `exr/${safeId}.exr`;
    const host = `${BUCKET}.${TOS_ENDPOINT}`;
    const path = `/${encodePath(key)}`;
    const extraHeaders = { 'content-type': contentType };
    if (Number.isFinite(contentLength)) extraHeaders['content-length'] = String(contentLength);
    const headers = signTosRequest({ method: 'PUT', host, path, ak, sk, extraHeaders });
    const put = await fetch(`https://${host}${path}`, {
        method: 'PUT',
        headers,
        body: upstream.body,
        duplex: 'half',
    });
    if (!put.ok) {
        const body = await put.text().catch(() => '');
        return {
            key: null,
            url,
            durable: false,
            bytes: Number.isFinite(contentLength) ? contentLength : null,
            archiveError: uploadErrorMessage(put.status, body),
        };
    }
    return { key, url: presignGetUrl({ host, path, ak, sk, expiresSec: 604800 }), durable: true, bytes: Number.isFinite(contentLength) ? contentLength : null, archiveError: null };
}
