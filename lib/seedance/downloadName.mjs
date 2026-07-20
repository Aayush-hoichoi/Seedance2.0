// Filename handling for the download proxy (app/api/seedance/download). Both
// videos and images come through that route, so the saved name has to carry the
// asset's *real* extension — an image saved as .mp4 won't open.

// The asset's extension, taken from the URL path (images are .png/.jpeg/.webp,
// videos .mp4). Presigned links keep the object key in the path, so this is
// reliable; .mp4 is the fallback since videos are the common case.
export function extFromUrl(url) {
    try {
        const m = /\.([a-z0-9]{2,4})$/i.exec(new URL(url).pathname);
        return m ? `.${m[1].toLowerCase()}` : '.mp4';
    } catch {
        return '.mp4';
    }
}

// Download-safe filename: no path separators, no control characters or quotes
// (they'd break the Content-Disposition header), sane length, correct extension.
export function safeName(name, url, fallback) {
    let base = typeof name === 'string' ? name.trim() : '';
    base = base.replace(/[/\\]+/g, '_').replace(/[\u0000-\u001f"]/g, '').slice(0, 120);
    if (!base) base = fallback;
    const ext = extFromUrl(url);
    if (!base.toLowerCase().endsWith(ext)) base += ext;
    return base;
}
