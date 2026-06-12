// Client-side helpers that speak ModelArk's create-task / poll protocol
// through our same-origin /api/byteplus proxy (which injects the Bearer key).

import { POLL_INTERVAL_MS, POLL_MAX_ATTEMPTS } from './constants.js';

const TASKS_PATH = '/api/byteplus/contents/generations/tasks';
const TERMINAL = ['succeeded', 'failed', 'cancelled', 'expired'];

// Read a File as a ModelArk-compatible base64 data URL:
// `data:image/png;base64,...`. Used for image and audio inputs.
export function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
        reader.readAsDataURL(file);
    });
}

function contentItem(kind, url, role) {
    if (kind === 'image') return { type: 'image_url', image_url: { url }, ...(role ? { role } : {}) };
    if (kind === 'video') return { type: 'video_url', video_url: { url }, role: role || 'reference_video' };
    if (kind === 'audio') return { type: 'audio_url', audio_url: { url }, role: role || 'reference_audio' };
    throw new Error(`Unknown media kind: ${kind}`);
}

// Assemble the ModelArk request body from form state.
// `mediaItems` is a flat list of { kind, url, role } already resolved to
// URLs or base64 data URLs by the caller.
export function buildPayload({ options, prompt, mediaItems }) {
    const content = [];
    if (prompt && prompt.trim()) content.push({ type: 'text', text: prompt.trim() });
    for (const m of mediaItems) {
        if (!m.url) continue;
        content.push(contentItem(m.kind, m.url, m.role));
    }
    if (content.length === 0) {
        throw new Error('Nothing to generate: add a prompt or at least one media input.');
    }

    const payload = {
        model: options.model,
        content,
        ratio: options.ratio,
        resolution: options.resolution,
        generate_audio: options.generate_audio,
        watermark: options.watermark,
    };
    // duration: -1 means "let the model decide" — send it explicitly.
    if (options.duration !== undefined && options.duration !== null) payload.duration = options.duration;
    if (options.seed !== undefined && options.seed !== null && options.seed !== '') {
        payload.seed = Number(options.seed);
    }
    return payload;
}

function extractError(data, fallback) {
    if (!data) return fallback;
    if (typeof data.error === 'string') return data.error;
    if (data.error?.message) return data.error.message;
    if (data.message) return data.message;
    return fallback;
}

// fetch() rejects with an opaque "Failed to fetch" when the app server is
// unreachable (connection drop, dev server restart); translate that into
// something actionable and mark it transient so pollers can ride it out.
function networkError() {
    const e = new Error('Could not reach the app server — check your connection (in local dev, that `npm run dev` is running), then try again.');
    e.transient = true;
    return e;
}

async function postJson(path, body) {
    let res;
    try {
        res = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch {
        throw networkError();
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(extractError(data, `Request failed (${res.status})`));
    return data;
}

async function getJson(path) {
    let res;
    try {
        res = await fetch(path);
    } catch {
        throw networkError();
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
        const e = new Error(extractError(data, `Poll failed (${res.status})`));
        e.transient = res.status >= 500; // gateway/server hiccups recover; 4xx won't
        throw e;
    }
    return data;
}

// Create a generation task. Returns the task id.
export async function createTask(payload) {
    const data = await postJson(TASKS_PATH, payload);
    const id = data?.id;
    if (!id) throw new Error('ModelArk did not return a task id.');
    return id;
}

// Poll a task until it reaches a terminal state. Returns the video URL on
// success, throws with the ModelArk reason on failure. `onStatus` reports
// intermediate status strings (queued/running) for UI feedback.
// Transient failures (connection drop, dev-server restart, 5xx) never kill
// the job — the task keeps rendering server-side, so keep polling through
// them and only give up after several consecutive minutes of no contact.
const MAX_CONSECUTIVE_POLL_FAILURES = 60; // ~3 min of unreachable server
export async function pollTask(id, { onStatus, signal } = {}) {
    let failures = 0;
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
        if (signal?.aborted) throw new Error('Cancelled.');
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        let data;
        try {
            data = await getJson(`${TASKS_PATH}/${id}`);
            failures = 0;
        } catch (e) {
            if (e.transient && ++failures < MAX_CONSECUTIVE_POLL_FAILURES) continue;
            throw e;
        }
        const status = (data.status || '').toLowerCase();
        if (onStatus) onStatus(status);
        if (status === 'succeeded') {
            const url = data.content?.video_url;
            if (!url) throw new Error('Task succeeded but no video_url was returned.');
            return { url, raw: data };
        }
        if (TERMINAL.includes(status)) {
            throw new Error(extractError(data, `Generation ${status}.`));
        }
    }
    throw new Error('Timed out waiting for the video to finish.');
}
