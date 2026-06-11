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

async function callAsset(action, payload) {
    const res = await fetch(ASSETS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, payload }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(extractError(data, `${action} failed (${res.status})`));
    if (data?.ResponseMetadata?.Error) throw new Error(extractError(data, `${action} failed.`));
    return data;
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

// Full register flow: public URL → CreateAsset → poll Active → media item.
export async function registerAssetFromUrl({ url, kind, onStatus }) {
    const groupId = await ensureUploadGroup();
    if (onStatus) onStatus('Registering');
    const id = await createAsset({ groupId, url, kind });
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
