// Client helper: hand a list of finished generations to the server download
// route and save what comes back. One item → the raw file; many → a single .zip.
// items: [{ url, name }]  (url = the generation's current signed media URL).

// format: 'mov' (default — videos are rewrapped as QuickTime), 'mp4',
// 'prores' (ProRes 4444 .mov — keeps 10-bit 4:4:4), or 'quicktime' (streams a
// large source through an H.264 QuickTime conversion). fps: 25 retimes the
// video to 25 fps for PAL/broadcast delivery.
export async function downloadAssets(items, { raw = false, format = 'mov', fps = null } = {}) {
    if (!Array.isArray(items) || !items.length) return;

    const endpoint = !raw && format === 'prores' ? '/api/seedance/download/prores' : '/api/seedance/download';
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, raw, format, ...(fps ? { fps } : {}),
            ...(!raw && format === 'prores' ? { delivery: 'stored' } : {}) }),
    });

    if (!res.ok) {
        let message = `Download failed (${res.status}).`;
        try {
            const data = await res.json();
            if (data?.error) message = data.error;
        } catch {
            // non-JSON error body — keep the status-based message
        }
        const error = new Error(message);
        error.status = res.status;
        throw error;
    }

    const fallback = items.length === 1 ? items[0].name || 'download' : 'seedance-assets.zip';
    if (res.headers?.get('content-type')?.includes('application/json')) {
        const ready = await res.json();
        let url;
        try { url = new URL(ready.downloadUrl); } catch { /* reject an incomplete result below */ }
        if (!url || url.protocol !== 'https:' || url.username || url.password
            || !Number.isSafeInteger(ready.bytes) || ready.bytes <= 0) {
            throw new Error('The server did not return a completed video download. Please retry.');
        }
        // The private object has attachment metadata and exists only after the
        // complete conversion is verified. Let the browser's download manager
        // receive it directly instead of buffering a large ProRes MOV in a blob.
        saveUrl(url.href, ready.name || fallback);
        return;
    }
    const blob = await res.blob();
    saveBlob(blob, filenameFromDisposition(res.headers.get('content-disposition')) || fallback);
}

// What every download button in the UI should call. A bare `<a download>` can't
// do this job: the assets are cross-origin presigned links, and browsers ignore
// the download attribute cross-origin — the file just opens in a tab. Routing
// through the proxy gives a real save. Completed ProRes files instead carry
// attachment metadata in private storage. Only an explicit Original request
// can fall back to opening the source if the proxy is unavailable.
export function downloadAsset(url, name, taskId, opts) {
    if (!url) return;
    return downloadAssets([{ url, name, taskId }], opts).catch(async (error) => {
        const { default: toast } = await import('react-hot-toast');
        toast.error(error?.message || 'Download failed.');
        // The source may be HEVC or use a different container/frame rate.
        // A failed conversion must not silently substitute that original.
        if (opts?.raw) window.open(url, '_blank', 'noopener');
    });
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
    return downloadAsset(url, name, taskId, opts);
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
    saveUrl(url, filename);
    // Revoke after the click has had a tick to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function saveUrl(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
}
