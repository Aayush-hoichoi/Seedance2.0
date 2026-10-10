import { signTosRequest, encodePath, TOS_ENDPOINT } from '../byteplus/tosSign.js';
import { archiveKeyForTask } from './archiveKey.mjs';
import { imageKeyForJob } from '../gateway/storage.mjs';

// A failed authorization check is not evidence of a missing object.
export async function objectExists(key, fetcher = fetch) {
    const response = await storageRequest('HEAD', key, undefined, undefined, fetcher);
    if (response.ok) return true;
    if (response.status === 404) return false;
    throw new Error(`Storage check failed (${response.status}). Check storage credentials and permissions.`);
}

async function storageRequest(method, key, body, type, fetcher = fetch) {
    const ak = process.env.ARK_AK?.trim();
    const sk = process.env.ARK_SK?.trim();
    if (!ak || !sk) throw new Error('Storage credentials are not configured.');
    const host = `${process.env.TOS_BUCKET?.trim() || 'seedance-studio-assets'}.${TOS_ENDPOINT}`;
    const path = `/${encodePath(key)}`;
    const extraHeaders = method === 'PUT' ? { 'content-type': type, 'if-none-match': '*' } : {};
    return fetcher(`https://${host}${path}`, {
        method, body, headers: signTosRequest({ method, host, path, ak, sk, extraHeaders }),
        signal: AbortSignal.timeout(20000), redirect: 'error',
    });
}

async function sourceBytes(url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('No usable source copy is recorded.'); }
    // Only known provider media hosts; never follow a redirect to an arbitrary host.
    if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password
        || !/\.(volces\.com|bytepluses\.com)$/.test(parsed.hostname)) {
        throw new Error('This source cannot be recovered automatically. A saved copy is needed.');
    }
    const res = await fetch(parsed, { signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!res.ok) throw new Error(`Source unavailable (${res.status}); its temporary link may have expired.`);
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
        size += chunk.length;
        if (size > 200 * 1024 * 1024) throw new Error('Source exceeds the recovery size limit.');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function save(key, bytes, type) {
    const response = await storageRequest('PUT', key, bytes, type);
    // Another recovery may have saved this object while we fetched the source.
    if (!response.ok && response.status !== 412) throw new Error(`Storage save failed (${response.status}).`);
}

export async function recoverGeneration(job, dependencies = {}) {
    const exists = dependencies.exists || objectExists;
    const read = dependencies.read || sourceBytes;
    const write = dependencies.write || save;
    const result = structuredClone(job.result || {});
    const deadline = Date.now() + 30000;
    let recovered = 0;
    const problems = [];
    if (job.category === 'image') {
        if (!result.images?.length) return { result, recovered, problems: ['No image source is recorded.'] };
        for (let i = 0; i < result.images.length; i++) {
            if (Date.now() > deadline) {
                problems.push('Remaining images were deferred to keep this request within its time limit. Run recovery again.');
                break;
            }
            const img = result.images[i];
            const key = img.key || imageKeyForJob(job.id, i, img.mimeType);
            try {
                if (!await exists(key)) {
                    const bytes = img.b64 ? Buffer.from(img.b64, 'base64') : await read(img.url);
                    await write(key, bytes, img.mimeType || 'image/png');
                    recovered++;
                }
                result.images[i] = { ...img, key };
            } catch (error) { problems.push(`Image ${i + 1}: ${error.message}`); }
        }
    } else {
        const key = result.video_key || archiveKeyForTask(job.provider_task_id);
        if (!key) return { result, recovered, problems: ['No video task identifier is recorded.'] };
        try {
            if (!await exists(key)) {
                await write(key, await read(result.video_url), 'video/mp4');
                recovered++;
            }
            result.video_key = key;
        } catch (error) { problems.push(error.message); }
    }
    return { result, recovered, problems };
}

export async function restoreBinned(sql, user) {
    // Update and attribution commit together, including legacy prompt records.
    const [row] = await sql.query(`WITH restored AS (
        UPDATE seedance_prompts SET deleted = false WHERE deleted = true RETURNING task_id
    ), logged AS (
        INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, before, after)
        SELECT $1, $2, 'generation.restore', 'generation', task_id,
            '{"deleted":true}'::jsonb, '{"deleted":false}'::jsonb FROM restored RETURNING id
    ) SELECT count(*)::int AS restored FROM logged`, [user.userId, user.email]);
    return row.restored;
}
