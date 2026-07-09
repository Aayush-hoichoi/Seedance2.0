'use client';

// Auto-fit an oversized reference image to the Seedance IMAGE_LIMITS before upload:
// scale the longest side down to maxDim and re-encode under the byte cap, aspect
// preserved. Returns the original File untouched when it already fits or can't be
// decoded (the validator then handles it). Canvas-based, no deps.
//
// ponytail: raster only — decodes the first frame of an animated GIF/WebP and drops
// the rest; Seedance rasterizes references anyway. Aspect-ratio / min-dimension
// violations aren't fixable by downscaling, so those still surface as validation
// errors upstream.

import { IMAGE_LIMITS } from './limits.js';

// Longest side clamped to maxDim, aspect preserved, rounded to whole px. Pure.
export function fitDims(width, height, maxDim) {
    const scale = Math.min(1, maxDim / Math.max(width, height));
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

function renameExt(name = '', type) {
    const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
    return `${name.replace(/\.[^./\\]+$/, '') || 'image'}.${ext}`;
}

function drawToBlob(bitmap, width, height, type, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    ctx.drawImage(bitmap, 0, 0, width, height);
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function fitImageToLimits(file) {
    const { maxDim, maxBytes, minDim } = IMAGE_LIMITS;
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) return file;

    try {
        if (Math.max(bitmap.width, bitmap.height) <= maxDim && file.size <= maxBytes) return file;

        // PNG/WebP keep their type (alpha survives); everything else re-encodes to JPEG.
        const type = file.type === 'image/png' ? 'image/png'
            : file.type === 'image/webp' ? 'image/webp'
            : 'image/jpeg';
        const lossy = type !== 'image/png';

        const base = fitDims(bitmap.width, bitmap.height, maxDim); // longest side ≤ maxDim
        let shrink = 1;      // extra reduction applied only when still over the byte cap
        let quality = 0.92;
        let blob = null;

        // Bounded loop backstop for the byte cap: drop JPEG quality first, then shrink
        // dimensions. ponytail: caps at 8 passes / minDim floor — a pathological >30MB
        // image lands at best-effort rather than looping forever.
        for (let i = 0; i < 8; i++) {
            const w = Math.max(minDim, Math.round(base.width * shrink));
            const h = Math.max(minDim, Math.round(base.height * shrink));
            blob = await drawToBlob(bitmap, w, h, type, quality);
            if (!blob) return file;
            const atFloor = w <= minDim && h <= minDim;
            if (blob.size <= maxBytes || atFloor) break;
            if (lossy && quality > 0.5) quality -= 0.15; else shrink *= 0.85;
        }

        return new File([blob], renameExt(file.name, type), { type });
    } finally {
        bitmap.close?.();
    }
}
