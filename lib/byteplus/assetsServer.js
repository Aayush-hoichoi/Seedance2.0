// lib/byteplus/assetsServer.js — server-side twin of lib/seedance/assetsClient.js.
// ponytail: thin duplication of 5 wrappers; unify behind an injected transport
// if a third caller ever appears.
import { signAssetRequest, assetUrl } from './assetSign.js';
import { uploadGroupName } from '../seedance/assetsClient.js';

const DEFAULT_PROJECT = 'default';
// AssetType (Image/Video/Audio) → the media kind + reference role our payload uses.
const ASSET_TYPE_TO_KIND = { Image: 'image', Video: 'video', Audio: 'audio' };
const KIND_TO_ROLE = { image: 'reference_image', video: 'reference_video', audio: 'reference_audio' };
const KIND_TO_ASSET_TYPE = { image: 'Image', video: 'Video', audio: 'Audio' };
const uploadGroupCache = new Map();

// BytePlus QPS-throttles the asset APIs account-wide (see
// lib/seedance/assetsClient.js's callAsset — same detection/backoff, ported
// here because register_asset's pollAssetActive multiplies server-side call
// volume). Throttle responses back off and retry instead of failing outright.
// qp[sm], not qps: the account-wide limit this file backs off from is the
// PER-MINUTE one named two comments down (QuotaWriteQPMExceeded), and `qps`
// never matched it. Unmatched, it fell through to the caller's /quota/i test
// and was mistaken for a full asset pool — which triggers deletions.
const THROTTLE_RE = /throttl|rate.?limit|too many|too frequent|flow.?limit|qp[sm]/i;
const THROTTLE_RETRIES = 6; // 1s,2s,4s,8s,16s,32s (+jitter) ≈ 63s worst — crosses the per-minute write-quota window

// Writes share the account-wide 120 QPM zero-burst quota (429
// QuotaWriteQPMExceeded on parallel CreateAssets) — serialize them, reads
// stay parallel. Mirrors assetsClient.js.
const WRITE_ACTIONS = new Set(['CreateAsset', 'DeleteAsset', 'CreateAssetGroup', 'UpdateAsset', 'DeleteAssetGroup']);
let writeChain = Promise.resolve();

export function callAsset(action, payload) {
    if (!WRITE_ACTIONS.has(action)) return callAssetNow(action, payload);
    const run = writeChain.then(() => callAssetNow(action, payload));
    writeChain = run.then(() => {}, () => {});
    return run;
}

async function callAssetNow(action, payload) {
    const ak = process.env.ARK_AK?.trim();
    const sk = process.env.ARK_SK?.trim();
    if (!ak || !sk) throw new Error('ARK_AK / ARK_SK are not configured on the server.');
    const bodyStr = JSON.stringify(payload ?? {});
    for (let attempt = 0; ; attempt++) {
        const headers = signAssetRequest({ action, bodyStr, ak, sk });
        const res = await fetch(assetUrl(action), { method: 'POST', headers, body: bodyStr });
        const data = await res.json().catch(() => null);
        const apiError = data?.ResponseMetadata?.Error;
        if (res.ok && !apiError) return data;
        const message = apiError?.Message || `Asset API ${action} failed (${res.status}).`;
        const throttled = res.status === 429 || THROTTLE_RE.test(`${apiError?.Code || ''} ${message}`);
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
// deadlineMs (optional): a Date.now()-scale wall-clock cutoff so MCP callers
// can bail out before the route's maxDuration kills the function mid-poll.
export async function pollAssetActive(id, { intervalMs = 3000, maxAttempts = 40, onStatus, deadlineMs = null } = {}) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (deadlineMs && Date.now() > deadlineMs) {
            const err = new Error('Asset is still verifying.');
            err.code = 'STILL_PROCESSING';
            throw err;
        }
        const asset = await getAsset(id);
        if (onStatus) onStatus(asset.status);
        if (asset.status === 'Active') return asset;
        if (asset.status === 'Failed') throw new Error(asset.error || 'The source media didn’t pass verification and the provider returned no reason (usually a moderation flag on the content).');
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error('Timed out waiting for the asset to verify (still Processing).');
}

export async function deleteAsset(id) {
    await callAsset('DeleteAsset', { Id: id, ProjectName: DEFAULT_PROJECT });
}
