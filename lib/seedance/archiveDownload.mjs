// Server-only. Prepare a complete private MOV before handing its signed URL
// to the browser; large attachments should not traverse the app response.
import { createHash, randomUUID } from 'node:crypto';
import { signTosRequest, presignGetUrl, encodePath, TOS_ENDPOINT } from '../byteplus/tosSign.js';
import { safeName } from './downloadName.mjs';

const PART_BYTES = 8 * 1024 * 1024;
const PREPARE_TIMEOUT_MS = 275_000;
const CLEANUP_TIMEOUT_MS = 5_000;

function failure(message = 'ProRes download preparation failed. Please retry.', code = 'VIDEO_DOWNLOAD_PREPARATION_FAILED') {
    return Object.assign(new Error(message), { code });
}

function attachmentName(name) {
    const safe = safeName(String(name || 'video.mov').toWellFormed(), '', 'video.mov');
    return safe.replace(/\.[a-z0-9]{2,5}$/i, '') + '.mov';
}

function disposition(name) {
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// TOS multipart wire contract (JSON, not S3 XML):
// https://github.com/volcengine/ve-tos-js-sdk/tree/main/src/methods/object/multipart
// All non-final parts must be >= 5 MiB; one reusable 8 MiB buffer keeps memory
// bounded and sequential PUTs backpressure the encoder's existing stream.
export async function archiveProResDownload({ conversion, name, signal }) {
    const ak = process.env.ARK_AK?.trim();
    const sk = process.env.ARK_SK?.trim();
    const host = `${process.env.TOS_BUCKET?.trim() || 'seedance-studio-assets'}.${TOS_ENDPOINT}`;
    const key = `downloads/${randomUUID()}.mov`;
    const path = `/${encodePath(key)}`;
    const filename = attachmentName(name);
    const controller = new AbortController();
    let uploadId = null;
    let completeAttempted = false;
    let timedOut = false;
    let streamFailed = false;
    let canceledChild = false;
    const stopChild = () => {
        if (!canceledChild) { canceledChild = true; conversion.cancel(); }
    };
    const abort = () => {
        controller.abort();
        stopChild();
        conversion.stream.destroy(failure());
    };
    // The encoder starts before the create-upload request. Keep an error
    // listener installed even while its output is not yet being consumed.
    const onStreamError = () => { streamFailed = true; controller.abort(); stopChild(); };
    conversion.stream.on('error', onStreamError);
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; abort(); }, PREPARE_TIMEOUT_MS);
    timeout.unref?.();

    const assertActive = () => {
        if (signal?.aborted || timedOut || streamFailed || controller.signal.aborted) throw failure();
    };
    async function request(method, query, body, extraHeaders = {}, requestSignal = controller.signal) {
        const headers = signTosRequest({ method, host, path, query, ak, sk, extraHeaders });
        const response = await fetch(`https://${host}${path}${query ? `?${query}` : ''}`, {
            method, headers, ...(body === undefined ? {} : { body }), signal: requestSignal,
        });
        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw failure();
        }
        return response;
    }
    async function cleanup() {
        if (!uploadId) return;
        // The caller's signal is already aborted on cancellation. Cleanup must
        // have its own short deadline or it cannot remove provisional parts.
        const cleanupController = new AbortController();
        const cleanupTimeout = setTimeout(() => cleanupController.abort(), CLEANUP_TIMEOUT_MS);
        cleanupTimeout.unref?.();
        try {
            const query = `uploadId=${encodeURIComponent(uploadId)}`;
            await request('DELETE', query, undefined, {}, cleanupController.signal).catch(() => {});
            // A completion response can be lost after TOS commits the object.
            // This key is unique to this attempt, so deleting it is safe.
            if (completeAttempted) await request('DELETE', '', undefined, {}, cleanupController.signal).catch(() => {});
        } finally { clearTimeout(cleanupTimeout); }
    }

    try {
        if (!ak || !sk) throw failure('ProRes download storage is not configured.', 'VIDEO_DOWNLOAD_STORAGE_UNAVAILABLE');
        assertActive();
        const created = await request('POST', 'uploads=', undefined, {
            'content-type': 'video/quicktime', 'content-disposition': disposition(filename),
            // Only this temporary derivative expires; no bucket policy change.
            'x-tos-acl': 'private', 'x-tos-object-expires': '1',
        });
        const initial = await created.json();
        if (typeof initial.UploadId !== 'string' || !initial.UploadId) throw failure();
        uploadId = initial.UploadId;
        assertActive();
        const buffer = Buffer.allocUnsafe(PART_BYTES);
        let used = 0;
        let bytes = 0;
        const parts = [];
        const uploadPart = async (length) => {
            assertActive();
            const partNumber = parts.length + 1;
            if (partNumber > 10_000) throw failure();
            const body = buffer.subarray(0, length);
            const query = `partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`;
            const uploaded = await request('PUT', query, body, {
                'content-length': String(length),
                'content-md5': createHash('md5').update(body).digest('base64'),
            });
            const etag = uploaded.headers.get('etag');
            await uploaded.body?.cancel();
            if (!etag) throw failure();
            parts.push({ PartNumber: partNumber, ETag: etag });
        };
        for await (const chunk of conversion.stream) {
            assertActive();
            for (let offset = 0; offset < chunk.length;) {
                const length = Math.min(PART_BYTES - used, chunk.length - offset);
                chunk.copy(buffer, used, offset, offset + length);
                used += length;
                offset += length;
                bytes += length;
                if (used === PART_BYTES) { await uploadPart(used); used = 0; }
            }
        }
        // A clean stream EOF includes the converter's duration guard; still
        // await actual child close before making any object downloadable.
        await conversion.done;
        assertActive();
        if (!bytes) throw failure();
        if (used) await uploadPart(used);
        assertActive();
        completeAttempted = true;
        const completed = await request('POST', `uploadId=${encodeURIComponent(uploadId)}`,
            JSON.stringify({ Parts: parts }), { 'content-type': 'application/json' });
        const result = await completed.json();
        if (!result.ETag || result.Code) throw failure();
        assertActive();
        return { key, name: filename, bytes, url: presignGetUrl({ host, path, ak, sk, expiresSec: 3600 }) };
    } catch (error) {
        stopChild();
        conversion.stream.destroy();
        await Promise.allSettled([conversion.done, cleanup()]);
        if (error?.code === 'VIDEO_DOWNLOAD_STORAGE_UNAVAILABLE') throw error;
        if (signal?.aborted) throw failure('ProRes download preparation was canceled.');
        if (timedOut) throw failure('ProRes download preparation timed out. Please retry.');
        // Fetch/FFmpeg/TOS errors may contain credentials or private paths.
        throw failure();
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        conversion.stream.removeListener('error', onStreamError);
    }
}
