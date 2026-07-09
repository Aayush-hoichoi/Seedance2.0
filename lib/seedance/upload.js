'use client';

// Upload a file directly to TOS using a presigned PUT URL (no Vercel body limit).
// Flow: GET presign URL from our API → browser PUT to TOS → return the presigned
// GET URL plus the stable TOS key (re-presignable forever via /api/byteplus/archive).

export async function uploadToCdn(file) {
    const params = new URLSearchParams({ name: file.name, type: file.type || 'application/octet-stream' });
    const presignRes = await fetch(`/api/byteplus/upload?${params}`);
    const presign = await presignRes.json().catch(() => null);
    if (!presignRes.ok) {
        throw new Error(presign?.error || `Failed to get upload URL (${presignRes.status}).`);
    }

    const put = await fetch(presign.putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': presign.contentType },
        body: file,
    });
    if (!put.ok) {
        const text = await put.text().catch(() => '');
        throw new Error(`Upload to storage failed (${put.status}): ${text.slice(0, 200)}`);
    }

    return { url: presign.getUrl, key: presign.key };
}
