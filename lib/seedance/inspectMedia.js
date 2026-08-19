'use client';

// Client-side media inspection: pull real pixel dimensions / duration / fps out
// of a File via the browser so we can enforce the Seedance limits BEFORE upload.
// Pairs with the pure validators in ./limits.js.

import {
    validateFileBasics,
    validateImageDimensions,
    validateVideoMetadata,
    validateAudioMetadata,
} from './limits.js';

function withObjectUrl(file, work) {
    const url = URL.createObjectURL(file);
    return Promise.resolve()
        .then(() => work(url))
        .finally(() => URL.revokeObjectURL(url));
}

export function inspectImage(file) {
    return withObjectUrl(file, (url) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error('Could not read this image.'));
        img.src = url;
    }));
}

// FPS is not exposed directly; sample two frames via requestVideoFrameCallback
// and derive it. Best-effort — resolves fps:null when the API is unavailable.
function sampleFps(video) {
    return new Promise((resolve) => {
        if (typeof video.requestVideoFrameCallback !== 'function') return resolve(null);
        let first = null;
        const tick = (_now, meta) => {
            if (first === null) {
                first = meta;
                video.requestVideoFrameCallback(tick);
                return;
            }
            const dt = meta.mediaTime - first.mediaTime;
            const df = meta.presentedFrames - first.presentedFrames;
            resolve(dt > 0 && df > 0 ? df / dt : null);
        };
        video.requestVideoFrameCallback(tick);
        video.play().catch(() => resolve(null));
        setTimeout(() => resolve(null), 1500); // give up rather than hang
    });
}

export function inspectVideo(file) {
    return withObjectUrl(file, (url) => new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.muted = true;
        video.onloadedmetadata = async () => {
            const base = {
                width: video.videoWidth,
                height: video.videoHeight,
                durationSec: Number.isFinite(video.duration) ? video.duration : null,
            };
            const fps = await sampleFps(video).catch(() => null);
            video.removeAttribute('src');
            resolve({ ...base, fps });
        };
        video.onerror = () => reject(new Error('Could not read this video.'));
        video.src = url;
    }));
}

export function inspectAudio(file) {
    return withObjectUrl(file, (url) => new Promise((resolve, reject) => {
        const audio = document.createElement('audio');
        audio.preload = 'metadata';
        audio.onloadedmetadata = () => resolve({ durationSec: Number.isFinite(audio.duration) ? audio.duration : null });
        audio.onerror = () => reject(new Error('Could not read this audio file.'));
        audio.src = url;
    }));
}

// One call: validate a File for the given kind. Returns { error, meta }.
// error is a user-facing string (null when valid); meta carries inspected
// width/height/durationSec/fps so the caller can run aggregate checks later.
// modelKind selects the reference-video window: 2.5 requires 4-30s where 2.0
// allows 2-15s. Passed from the caller because the limits are per model, and
// omitting it keeps the conservative 2.0 spec.
export async function validateMediaFile(kind, file, modelKind = null) {
    const basic = validateFileBasics(kind, file);
    if (basic) return { error: basic, meta: {} };

    try {
        if (kind === 'image') {
            const meta = await inspectImage(file);
            return { error: validateImageDimensions(meta.width, meta.height), meta };
        }
        if (kind === 'video') {
            const meta = await inspectVideo(file);
            return { error: validateVideoMetadata(meta, modelKind), meta };
        }
        if (kind === 'audio') {
            const meta = await inspectAudio(file);
            return { error: validateAudioMetadata(meta), meta };
        }
    } catch (e) {
        return { error: e.message, meta: {} };
    }
    return { error: null, meta: {} };
}
