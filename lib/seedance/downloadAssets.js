// Client helper: hand a list of finished generations to the server download
// route and save what comes back. One item → the raw file; many → a single .zip.
// items: [{ url, name }]  (url = the generation's current signed media URL).

// format: 'mov' (default — videos are rewrapped as QuickTime) or 'mp4'.
export async function downloadAssets(items, { raw = false, format = 'mov' } = {}) {
    if (!Array.isArray(items) || !items.length) return;

    const res = await fetch('/api/seedance/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, raw, format }),
    });

    if (!res.ok) {
        let message = `Download failed (${res.status}).`;
        try {
            const data = await res.json();
            if (data?.error) message = data.error;
        } catch {
            // non-JSON error body — keep the status-based message
        }
        throw new Error(message);
    }

    const blob = await res.blob();
    const fallback = items.length === 1 ? items[0].name || 'download' : 'seedance-assets.zip';
    saveBlob(blob, filenameFromDisposition(res.headers.get('content-disposition')) || fallback);
}

// What every download button in the UI should call. A bare `<a download>` can't
// do this job: the assets are cross-origin presigned links, and browsers ignore
// the download attribute cross-origin — the file just opens in a tab. Routing
// through the proxy gives a real save; opening the asset is only the last-resort
// fallback if the proxy can't reach it (expired link, offline).
export function downloadAsset(url, name, taskId, opts) {
    if (!url) return;
    downloadAssets([{ url, name, taskId }], opts).catch(() => window.open(url, '_blank', 'noopener'));
}

// Refresh a durable TOS object URL before downloading it. The stored object
// key is permanent; the signed URL is intentionally short-lived.
export async function downloadArchivedAsset(key, fallbackUrl, name, taskId, opts) {
    let url = fallbackUrl;
    if (key) {
        try {
            const response = await fetch(`/api/byteplus/archive?key=${encodeURIComponent(key)}`);
            const data = response.ok ? await response.json() : null;
            url = data?.url || url;
        } catch { /* use the last known URL as a fallback */ }
    }
    downloadAsset(url, name, taskId, opts);
}

// Pull the filename out of a Content-Disposition header, preferring the RFC 5987
// `filename*=UTF-8''…` form (handles non-ASCII names) over plain `filename="…"`.
function filenameFromDisposition(header) {
    if (!header) return null;
    const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (star) {
        try { return decodeURIComponent(star[1]); } catch { /* fall through */ }
    }
    const plain = /filename="?([^";]+)"?/i.exec(header);
    return plain ? plain[1] : null;
}

function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke after the click has had a tick to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}
