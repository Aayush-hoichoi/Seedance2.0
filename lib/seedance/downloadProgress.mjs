// Only active downloads live here. Preview components can unmount while a
// request continues; reopening the same asset must recover its pending state.
const active = new Map();
const listeners = new Map();

export function downloadKeyForAsset(asset) {
    if (asset?.taskId) return String(asset.taskId);
    const jobId = asset?.genId ?? asset?.gatewayId;
    if (jobId != null) return `job:${jobId}`;
    return asset?.id != null ? `local:${asset.id}` : null;
}

export function getDownloadProgress(key) {
    return active.get(key)?.kind ?? null;
}

export function subscribeToDownload(key, listener) {
    let subscribers = listeners.get(key);
    if (!subscribers) listeners.set(key, subscribers = new Set());
    subscribers.add(listener);
    return () => {
        subscribers.delete(listener);
        if (!subscribers.size) listeners.delete(key);
    };
}

function notify(key) {
    for (const listener of listeners.get(key) ?? []) listener();
}

export function runTrackedDownload(key, download, kind = 'video') {
    const existing = active.get(key);
    if (existing) return existing.promise;
    const promise = Promise.resolve().then(download).finally(() => {
        active.delete(key);
        notify(key);
    });
    active.set(key, { kind, promise });
    notify(key);
    return promise;
}
