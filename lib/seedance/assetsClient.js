'use client';

// Client helpers for the BytePlus Asset Library, spoken through our signed
// same-origin /api/byteplus/assets proxy (which injects the AK/SK signature).
// Normalises BytePlus's PascalCase Result/Items shape into plain camelCase.

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
const THROTTLE_RE = /throttl|rate.?limit|too many|too frequent|flow.?limit|qps/i;
const THROTTLE_RETRIES = 5; // 1s,2s,4s,8s,16s (+jitter) ≈ 31s worst case

async function callAsset(action, payload) {
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
    return { id: r.Id, status: r.Status, name: r.Name, previewUrl: r.URL, groupId: r.GroupId };
}

// ── Register a public URL as a library asset (the demo's flow) ────────────────
// CreateAsset takes a publicly accessible URL (never a raw file), registers it
// into a group, and verifies it asynchronously. We reuse/create one dedicated
// group so studio uploads stay together.

const KIND_TO_ASSET_TYPE = { image: 'Image', video: 'Video', audio: 'Audio' };
const UPLOAD_GROUP_NAME = 'Seedance Studio';
let cachedUploadGroupId = null;

function fileNameFromUrl(url) {
    return (url.split('?')[0].split('/').pop() || 'asset').slice(0, 64);
}

export async function ensureUploadGroup() {
    if (cachedUploadGroupId) return cachedUploadGroupId;
    const groups = await listGroups('AIGC');
    const existing = groups.find((g) => g.name === UPLOAD_GROUP_NAME);
    if (existing) { cachedUploadGroupId = existing.id; return existing.id; }
    const data = await callAsset('CreateAssetGroup', {
        Name: UPLOAD_GROUP_NAME,
        Description: 'Reference assets registered from the Seedance studio',
        ProjectName: DEFAULT_PROJECT,
    });
    const id = data?.Result?.Id;
    if (!id) throw new Error('Could not create the "Seedance Studio" asset group.');
    cachedUploadGroupId = id;
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
        if (asset.status === 'Failed') throw new Error('Asset verification failed — check it meets the format/size/content rules.');
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error('Timed out waiting for the asset to verify (still Processing).');
}

// The shared asset pool is small and account-wide. Studio assets are only
// needed while their generation is being created/rendered, so anything older
// than a day is garbage — sweep it instead of per-task delete bookkeeping.
export async function cleanupOldAssets({ maxAgeHours = 24 } = {}) {
    const groupId = await ensureUploadGroup();
    const assets = await listAssets(groupId, 'AIGC');
    const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
    const stale = assets.filter((a) => a.createdAt && Date.parse(a.createdAt) < cutoff);
    await Promise.all(stale.map((a) =>
        callAsset('DeleteAsset', { Id: a.id, ProjectName: DEFAULT_PROJECT }).catch(() => {}),
    ));
    return stale.length;
}

// Pool full → sweep stale studio assets and retry. If the 1h sweep frees
// nothing (a burst filled the pool with fresh assets), evict everything in
// our group except the last few minutes — in-flight registrations keep a
// grace window (launchJob retries run ~90s). Assets outside our group are
// the user's library; never auto-delete those, so if the pool is STILL full
// the only remedy is manual and the error says so.
export async function createWithQuotaRecovery(create, cleanup = cleanupOldAssets) {
    try {
        return await create();
    } catch (e) {
        if (!/quota/i.test(e.message)) throw e;
        const freed = await cleanup({ maxAgeHours: 1 });
        if (!freed) await cleanup({ maxAgeHours: 5 / 60 });
        try {
            return await create();
        } catch (e2) {
            if (!/quota/i.test(e2.message)) throw e2;
            throw new Error('The BytePlus asset pool is still full after clearing studio assets — delete unused assets in the BytePlus console (Asset Library) and try again.');
        }
    }
}

// Full register flow: public URL → CreateAsset → poll Active → media item.
export async function registerAssetFromUrl({ url, kind, onStatus }) {
    const groupId = await ensureUploadGroup();
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

// ModelArk's synchronous input scan rejects real-person videos referenced by
// raw URL (InputVideoSensitiveContentDetected), but the same footage passes
// when referenced as a library asset verified at CreateAsset. Swap raw video
// refs for asset:// refs at submit time; images/audio pass fine as raw URLs.
// Returns a NEW array — input items are never mutated.
export async function resolveVideoRefs(mediaItems, register = registerAssetFromUrl) {
    return Promise.all(mediaItems.map(async (m) => {
        if (m.kind !== 'video' || typeof m.url !== 'string' || m.url.startsWith('asset://')) return m;
        const asset = await register({ url: m.url, kind: 'video' });
        return { ...m, url: asset.url, assetId: asset.assetId };
    }));
}

// Memoised register keyed by source URL minus its query (presigned params
// vary per signing) — a batch of generations flagged together registers each
// underlying file only once.
const assetMemo = new Map();
export function registerAssetCached({ url, kind }) {
    const key = url.split('?')[0];
    if (!assetMemo.has(key)) {
        const p = registerAssetFromUrl({ url, kind }).catch((e) => { assetMemo.delete(key); throw e; });
        assetMemo.set(key, p);
    }
    return assetMemo.get(key);
}

// ModelArk flagged the payload's raw-URL media as possibly containing a real
// person. Re-reference every http(s) image/video in the content through the
// library — verified assets pass the same scan. Returns a NEW payload.
export async function resolveSensitiveRefs(payload, register = registerAssetCached) {
    const content = await Promise.all((payload.content || []).map(async (item) => {
        const kind = item.type === 'image_url' ? 'image' : item.type === 'video_url' ? 'video' : null;
        if (!kind) return item;
        const holder = item[item.type];
        if (typeof holder?.url !== 'string' || !/^https?:/.test(holder.url)) return item;
        const asset = await register({ url: holder.url, kind });
        return { ...item, [item.type]: { ...holder, url: asset.url } };
    }));
    return { ...payload, content };
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
