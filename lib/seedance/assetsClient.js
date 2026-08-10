'use client';

// Client helpers for the BytePlus Asset Library, spoken through our signed
// same-origin /api/byteplus/assets proxy (which injects the AK/SK signature).
// Normalises BytePlus's PascalCase Result/Items shape into plain camelCase.

import { UPLOAD_GROUP_NAME, uploadGroupName } from './assetGroupName.mjs';

const ASSETS_ENDPOINT = '/api/byteplus/assets';
const DEFAULT_PROJECT = 'default';

// GroupType maps to the console's tabs. AIGC ("Virtual Portrait") is listed
// first because that's where uploaded portrait groups land; LivenessFace
// ("Real human") is the liveness-verified variant.
export const GROUP_TYPES = [
    { id: 'AIGC', label: 'Virtual' },
    { id: 'LivenessFace', label: 'Real human' },
];

// AssetType (Image/Video/Audio) → the media kind + reference role our payload uses.
const ASSET_TYPE_TO_KIND = { Image: 'image', Video: 'video', Audio: 'audio' };
const KIND_TO_ROLE = { image: 'reference_image', video: 'reference_video', audio: 'reference_audio' };

function extractError(data, fallback) {
    if (!data) return fallback;
    if (typeof data.error === 'string') return data.error;
    if (data.error?.message) return data.error.message;
    if (data.ResponseMetadata?.Error?.Message) return data.ResponseMetadata.Error.Message;
    return fallback;
}

// BytePlus QPS-throttles the asset APIs account-wide. A burst (parallel
// registrations + one poller per asset) can trip it, so throttle responses
// back off and retry here — every asset call routes through this — instead
// of failing the upload. Pool-full ("quota") is different and handled by
// createWithQuotaRecovery below.
// qp[sm], not qps: BytePlus's account-wide write limit is PER-MINUTE
// (QuotaWriteQPMExceeded), so `qps` never matched the error this backs off
// from. See createWithQuotaRecovery below for what that miss caused.
const THROTTLE_RE = /throttl|rate.?limit|too many|too frequent|flow.?limit|qp[sm]/i;
const THROTTLE_RETRIES = 6; // 1s,2s,4s,8s,16s,32s (+jitter) ≈ 63s worst — crosses the per-minute write-quota window

// Asset WRITES share an account-wide 120 QPM quota enforced with NO burst
// tolerance: a probe of 4 parallel CreateAssets got one 200 and three
// immediate 429 QuotaWriteQPMExceeded. Reads (GetAsset/List*) are unaffected.
// Chain writes so one submit (4 refs) or a batch delete never self-bursts;
// the backoff above absorbs cross-user overlap on the shared account.
const WRITE_ACTIONS = new Set(['CreateAsset', 'DeleteAsset', 'CreateAssetGroup', 'UpdateAsset', 'DeleteAssetGroup']);
let writeChain = Promise.resolve();

function callAsset(action, payload) {
    if (!WRITE_ACTIONS.has(action)) return callAssetNow(action, payload);
    const run = writeChain.then(() => callAssetNow(action, payload));
    writeChain = run.then(() => {}, () => {});
    return run;
}

async function callAssetNow(action, payload) {
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(ASSETS_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, payload }),
        });
        const data = await res.json().catch(() => null);
        const meta = data?.ResponseMetadata?.Error;
        if (res.ok && !meta) return data;
        const message = extractError(data, !res.ok ? `${action} failed (${res.status})` : `${action} failed.`);
        const throttled = res.status === 429 || THROTTLE_RE.test(`${meta?.Code || ''} ${message}`);
        if (throttled && attempt < THROTTLE_RETRIES) {
            await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 400));
            continue;
        }
        throw new Error(message);
    }
}

export async function listGroups(groupType, { pageSize = 100 } = {}) {
    const data = await callAsset('ListAssetGroups', {
        Filter: { GroupType: groupType },
        PageNumber: 1,
        PageSize: pageSize,
        SortBy: 'CreateTime',
        SortOrder: 'Desc',
        ProjectName: DEFAULT_PROJECT,
    });
    const items = data?.Result?.Items || [];
    return items.map((g) => ({
        id: g.Id,
        name: g.Name || '(unnamed group)',
        description: g.Description || '',
        groupType,
        createdAt: g.CreateTime,
    }));
}

export async function listAssets(groupId, groupType, { pageSize = 100 } = {}) {
    const data = await callAsset('ListAssets', {
        Filter: { GroupIds: [groupId], GroupType: groupType },
        PageNumber: 1,
        PageSize: pageSize,
        SortBy: 'CreateTime',
        SortOrder: 'Desc',
        ProjectName: DEFAULT_PROJECT,
    });
    const items = data?.Result?.Items || [];
    return items.map((a) => {
        const kind = ASSET_TYPE_TO_KIND[a.AssetType] || 'image';
        return {
            id: a.Id,
            name: a.Name || '',
            previewUrl: a.URL || '', // signed TOS URL, valid ~12h — for thumbnails only
            assetType: a.AssetType,
            kind,
            role: KIND_TO_ROLE[kind],
            status: a.Status, // Active | Processing | Failed
            groupId: a.GroupId || groupId,
            createdAt: a.CreateTime,
        };
    });
}

export async function getAsset(id) {
    const data = await callAsset('GetAsset', { Id: id, ProjectName: DEFAULT_PROJECT });
    const r = data?.Result || {};
    // On Status:Failed the reason is the ONLY actionable signal (e.g.
    // InputVideoSensitiveContentDetected). BytePlus is inconsistent about which
    // field carries it, so check every candidate before giving up.
    const error = r.Error?.Message || r.Error?.Code || r.FailReason || r.Reason || r.Message || r.StatusReason || null;
    return { id: r.Id, status: r.Status, name: r.Name, previewUrl: r.URL, groupId: r.GroupId, error };
}

// ── Register a public URL as a library asset (the demo's flow) ────────────────
// CreateAsset takes a publicly accessible URL (never a raw file), registers it
// into a group, and verifies it asynchronously. We reuse/create one dedicated
// group so studio uploads stay together.

const KIND_TO_ASSET_TYPE = { image: 'Image', video: 'Video', audio: 'Audio' };

// Cached per project id.
const uploadGroupCache = new Map();

// Re-exported for existing client importers; the definition lives in a module
// without 'use client' so the server helpers can share it (see assetGroupName).
export { uploadGroupName };

function fileNameFromUrl(url) {
    return (url.split('?')[0].split('/').pop() || 'asset').slice(0, 64);
}

export async function ensureUploadGroup(project = null) {
    const name = uploadGroupName(project);
    if (uploadGroupCache.has(name)) return uploadGroupCache.get(name);
    const groups = await listGroups('AIGC');
    // Match the exact per-project name, but also adopt an existing group whose
    // name starts with the legacy base + " #<id>" (survives a project rename).
    const suffix = project?.id ? ` #${project.id}` : null;
    const existing = groups.find((g) => g.name === name || (suffix && g.name.endsWith(suffix)));
    if (existing) { uploadGroupCache.set(name, existing.id); return existing.id; }
    const data = await callAsset('CreateAssetGroup', {
        Name: name,
        Description: project?.id ? `Reference assets for project #${project.id}` : 'Reference assets registered from the Seedance studio',
        ProjectName: DEFAULT_PROJECT,
    });
    const id = data?.Result?.Id;
    if (!id) throw new Error(`Could not create the "${name}" asset group.`);
    uploadGroupCache.set(name, id);
    return id;
}

export async function createAsset({ groupId, url, kind, name }) {
    const data = await callAsset('CreateAsset', {
        GroupId: groupId,
        URL: url,
        AssetType: KIND_TO_ASSET_TYPE[kind] || 'Image',
        Name: name || fileNameFromUrl(url),
        ProjectName: DEFAULT_PROJECT,
    });
    const id = data?.Result?.Id;
    if (!id) throw new Error('CreateAsset did not return an asset id.');
    return id;
}

// Poll GetAsset until the asset leaves Processing. CreateAsset is async and
// BytePlus runs a security/format review (typically 10–30s).
export async function pollAssetActive(id, { intervalMs = 3000, maxAttempts = 40, onStatus } = {}) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const asset = await getAsset(id);
        if (onStatus) onStatus(asset.status);
        if (asset.status === 'Active') return asset;
        if (asset.status === 'Failed') throw new Error(asset.error || 'The source media didn’t pass verification and the provider returned no reason (usually a moderation flag on the content).');
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error('Timed out waiting for the asset to verify (still Processing).');
}

// The shared asset pool is small and ACCOUNT-wide, but studio uploads are
// partitioned into per-project groups — so the sweep must cover every studio
// group, not just the current project's, or stale assets parked in other
// projects keep the pool full forever. Groups the studio didn't create are
// the user's own library and are never touched.
//
// Submits do NOT delete their own assets — that was removed so resolveMediaRefs
// can reuse them across submits and keep bursts off the 120 QPM write quota.
// Age sweeping is the only thing that returns capacity, so everything here is
// live until it ages out: renders take minutes, making 1h a generous garbage
// threshold (Reuse doesn't need pool assets — it re-presigns from tosKey).
// This copy only runs while a studio tab is open; assetsServer.js carries the
// server-side twin that runs without one.
export async function cleanupOldAssets({ maxAgeHours = 1 } = {}) {
    const groups = (await listGroups('AIGC')).filter((g) => g.name.startsWith(UPLOAD_GROUP_NAME));
    const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
    let freed = 0;
    for (const g of groups) {
        const assets = await listAssets(g.id, 'AIGC');
        const stale = assets.filter((a) => a.createdAt && Date.parse(a.createdAt) < cutoff);
        await Promise.all(stale.map((a) =>
            callAsset('DeleteAsset', { Id: a.id, ProjectName: DEFAULT_PROJECT }).catch(() => {}),
        ));
        freed += stale.length;
    }
    return freed;
}

// Pool full → sweep stale studio assets (all studio groups) and retry. If the
// 1h sweep frees nothing (a burst filled the pool with fresh assets), evict
// everything in the studio groups except the last few minutes — in-flight
// registrations keep a grace window (launchJob retries run ~90s). Assets
// outside the studio groups are the user's library; never auto-delete those,
// so if the pool is STILL full the only remedy is manual and the error says so.
// Not every "quota" is capacity. BytePlus's per-minute write limit surfaces as
// QuotaWriteQPMExceeded, and a bare /quota/i read that as a full pool — so a
// burst of parallel uploads made the studio DELETE its own reference assets
// (everything older than five minutes, across every studio group, potentially
// mid-render) and then tell the user the pool was full when it held four
// objects. Rate-shaped quotas belong to callAsset's backoff, which has already
// retried them six times by the time we get here; re-raise instead of sweeping.
export function isCapacityQuota(message = '') {
    return /quota/i.test(message) && !THROTTLE_RE.test(message);
}

export async function createWithQuotaRecovery(create, cleanup = cleanupOldAssets) {
    try {
        return await create();
    } catch (e) {
        if (!isCapacityQuota(e.message)) throw e;
        const freed = await cleanup({ maxAgeHours: 1 });
        if (!freed) await cleanup({ maxAgeHours: 5 / 60 });
        try {
            return await create();
        } catch (e2) {
            if (!isCapacityQuota(e2.message)) throw e2;
            throw new Error('The BytePlus asset pool is still full after clearing studio assets — delete unused assets in the BytePlus console (Asset Library) and try again.');
        }
    }
}

// Full register flow: public URL → CreateAsset → poll Active → media item.
// `project` (optional) routes the asset into that project's own group.
export async function registerAssetFromUrl({ url, kind, onStatus, project = null }) {
    const groupId = await ensureUploadGroup(project);
    if (onStatus) onStatus('Registering');
    const id = await createWithQuotaRecovery(() => createAsset({ groupId, url, kind }));
    if (onStatus) onStatus('Verifying');
    const asset = await pollAssetActive(id, { onStatus });
    return {
        kind,
        role: KIND_TO_ROLE[kind],
        url: `asset://${id}`,
        previewUrl: asset.previewUrl || url,
        name: asset.name || fileNameFromUrl(url),
        isImage: kind === 'image',
        assetId: id,
        fromLibrary: true,
    };
}

// ModelArk's synchronous input scan rejects real-person media referenced by raw
// URL — videos as InputVideoSensitiveContentDetected, still images as "the
// input image may contain real person" — but the same file passes when
// referenced as a library asset verified at CreateAsset. Route every raw http
// image/video ref through the library at submit time; audio passes fine as a
// raw URL, and asset:// / data: refs are already resolved. Returns a NEW array —
// input items are never mutated.
// Cross-submit registration cache. CreateAsset shares the account-wide
// 120 QPM zero-burst write quota (QuotaWriteQPMExceeded) with every user, so
// a ref that already registered must never spend another create: iterating on
// the same refs costs GetAsset reads only (reads aren't quota-limited).
// Keyed on kind+url minus its query (presigned params vary per signing), which
// also de-dupes the same file dropped in two slots within one submit. Entries
// settled in a PREVIOUS submit are re-validated before reuse and evicted when
// the age sweep (or anyone else) deleted the asset; failures are never cached.
const registeredRefs = new Map(); // key → { promise, settled }

export async function resolveMediaRefs(mediaItems, register = registerAssetFromUrl, verify = getAsset) {
    return Promise.all(mediaItems.map(async (m) => {
        const eligible = m.kind === 'image' || m.kind === 'video';
        if (!eligible || typeof m.url !== 'string' || !/^https?:/i.test(m.url)) return m;
        const key = `${m.kind}:${m.url.split('?')[0]}`;
        const cached = registeredRefs.get(key);
        if (cached?.settled) {
            // Registered in an earlier submit — reuse if the asset still exists.
            const prev = await cached.promise.catch(() => null);
            const live = prev && (await verify(prev.assetId).catch(() => null));
            if (live?.status === 'Active') return { ...m, url: prev.url, assetId: prev.assetId };
            if (registeredRefs.get(key) === cached) registeredRefs.delete(key);
        }
        let entry = registeredRefs.get(key);
        if (!entry) {
            entry = { promise: register({ url: m.url, kind: m.kind }), settled: false };
            entry.promise.then(() => { entry.settled = true; }, () => {});
            registeredRefs.set(key, entry);
        }
        try {
            const asset = await entry.promise;
            return { ...m, url: asset.url, assetId: asset.assetId };
        } catch (e) {
            if (registeredRefs.get(key) === entry) registeredRefs.delete(key);
            throw e;
        }
    }));
}

// Back-compat alias: the original scope was video-only. Real-person still images
// broke that assumption (they too must be verified as assets), so the function
// now covers both — the old name keeps working for existing callers/tests.
export const resolveVideoRefs = resolveMediaRefs;

export async function deleteAsset(id) {
    await callAsset('DeleteAsset', { Id: id, ProjectName: DEFAULT_PROJECT });
}

// Turn a picked library asset into a media item the studio's buildPayload uses:
// the reference URL is asset://<id>; previewUrl is only for the on-screen thumb.
export function assetToMediaItem(asset) {
    return {
        kind: asset.kind,
        role: asset.role,
        url: `asset://${asset.id}`,
        previewUrl: asset.previewUrl,
        name: asset.name || asset.id,
        isImage: asset.kind === 'image',
        assetId: asset.id,
        fromLibrary: true,
    };
}
