'use client';

// Auto-fit an oversized reference image to the Seedance IMAGE_LIMITS before upload:
// scale the longest side down to maxDim, letterbox out-of-range aspect ratios /
// sub-minDim sides onto a centered black canvas, and re-encode under the byte cap.
// Returns the original File untouched when it already fits or can't be decoded
// (the validator then handles it). Canvas-based, no deps.
//
// ponytail: raster only — decodes the first frame of an animated GIF/WebP and drops
// the rest; Seedance rasterizes references anyway.

import { IMAGE_LIMITS } from './limits.js';

// Longest side clamped to maxDim, aspect preserved, rounded to whole px. Pure.
export function fitDims(width, height, maxDim) {
    const scale = Math.min(1, maxDim / Math.max(width, height));
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

// Canvas box that makes width×height legal: pads the short side until the aspect
// ratio is back inside [minAspect, maxAspect] and both sides reach minDim. Equal
// to the input when it's already legal. Pure.
export function padDims(width, height) {
    const { minDim, minAspect, maxAspect } = IMAGE_LIMITS;
    return {
        width: Math.max(width, minDim, Math.ceil(height * minAspect)),
        height: Math.max(height, minDim, Math.ceil(width / maxAspect)),
    };
}

function renameExt(name = '', type) {
    const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
    return `${name.replace(/\.[^./\\]+$/, '') || 'image'}.${ext}`;
}

function drawToBlob(bitmap, width, height, type, quality, canvasW = width, canvasH = height) {
    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    if (canvasW !== width || canvasH !== height) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvasW, canvasH);
    }
    ctx.drawImage(bitmap, Math.round((canvasW - width) / 2), Math.round((canvasH - height) / 2), width, height);
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function fitImageToLimits(file) {
    const { maxDim, maxBytes, minDim } = IMAGE_LIMITS;
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) return file;

    try {
        const pad0 = padDims(bitmap.width, bitmap.height);
        const alreadyLegal = pad0.width === bitmap.width && pad0.height === bitmap.height;
        if (alreadyLegal && Math.max(bitmap.width, bitmap.height) <= maxDim && file.size <= maxBytes) return file;

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
            const w = Math.max(1, Math.round(base.width * shrink));
            const h = Math.max(1, Math.round(base.height * shrink));
            const box = padDims(w, h); // letterbox onto a legal canvas (no-op when already legal)
            blob = await drawToBlob(bitmap, w, h, type, quality, box.width, box.height);
            if (!blob) return file;
            const atFloor = box.width <= minDim && box.height <= minDim;
            if (blob.size <= maxBytes || atFloor) break;
            if (lossy && quality > 0.5) quality -= 0.15; else shrink *= 0.85;
        }

        return new File([blob], renameExt(file.name, type), { type });
    } finally {
        bitmap.close?.();
    }
}
