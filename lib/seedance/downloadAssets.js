// Client helper: hand a list of finished generations to the server download
// route and save what comes back. One item → an .mp4; many → a single .zip.
// items: [{ url, name }]  (url = the generation's current signed video URL).

export async function downloadAssets(items) {
    if (!Array.isArray(items) || !items.length) return;

    const res = await fetch('/api/seedance/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
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
    const fallback = items.length === 1 ? items[0].name || 'video.mp4' : 'seedance-assets.zip';
    saveBlob(blob, filenameFromDisposition(res.headers.get('content-disposition')) || fallback);
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
