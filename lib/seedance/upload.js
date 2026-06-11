'use client';

// Upload a local file to the user's own BytePlus TOS bucket via our server
// route (which signs with the server-only AK/SK) and return a presigned URL
// that BytePlus CreateAsset can fetch. Everything stays on BytePlus — no
// third-party hosting hop.

export async function uploadToCdn(file) {
    const form = new FormData();
    form.append('file', file);

    const res = await fetch('/api/byteplus/upload', { method: 'POST', body: form });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
        throw new Error(data?.error || `Upload failed (${res.status}).`);
    }
    if (!data?.url) throw new Error('Upload service returned no URL.');
    return data.url;
}
