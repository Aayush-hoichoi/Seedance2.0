// Server-only BytePlus VOD AI MediaKit enhancement client.

import crypto from 'node:crypto';

const DEFAULT_BASE = 'https://mediakit.ap-southeast-1.bytepluses.com/api/v1';
const DEFAULT_PATH = '/tools/enhance-video';

function baseUrl() {
    return (process.env.BYTEPLUS_VOD_MEDIAKIT_BASE_URL?.trim() || DEFAULT_BASE).replace(/\/$/, '');
}

function apiKey() {
    return process.env.BYTEPLUS_VOD_MEDIAKIT_API_KEY?.trim() || null;
}

function tokenSecret() {
    return process.env.BYTEPLUS_VOD_TASK_TOKEN_SECRET?.trim()
        || apiKey()
        || process.env.ARK_API_KEY?.trim()
        || 'logline-vod-task-token-development-secret';
}

function sign(value) {
    return crypto.createHmac('sha256', tokenSecret()).update(value).digest('base64url');
}

export function createTaskToken({ providerTaskId, userId }) {
    const payload = Buffer.from(JSON.stringify({ providerTaskId, userId }), 'utf8').toString('base64url');
    return `${payload}.${sign(payload)}`;
}

export function readTaskToken(token, userId) {
    if (typeof token !== 'string') return null;
    const [payload, signature] = token.split('.');
    if (!payload || !signature || signature !== sign(payload)) return null;
    try {
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!decoded?.providerTaskId || decoded.userId !== userId) return null;
        return decoded;
    } catch {
        return null;
    }
}

export function createQueueTaskToken({ queueId, userId }) {
    const payload = Buffer.from(JSON.stringify({ queueId: Number(queueId), userId }), 'utf8').toString('base64url');
    return `${payload}.${sign(payload)}`;
}

export function readQueueTaskToken(token, userId) {
    if (typeof token !== 'string') return null;
    const [payload, signature] = token.split('.');
    if (!payload || !signature || signature !== sign(payload)) return null;
    try {
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!Number.isInteger(decoded?.queueId) || decoded.queueId <= 0 || decoded.userId !== userId) return null;
        return decoded;
    } catch {
        return null;
    }
}

function headers() {
    const key = apiKey();
    return key ? { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } : null;
}

async function requestJson(url, init) {
    const response = await fetch(url, init);
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* use text below */ }
    if (!response.ok || data?.success === false) {
        const error = new Error(data?.error?.message || data?.error?.Message || data?.message || text.slice(0, 500) || response.statusText);
        error.status = response.status;
        throw error;
    }
    return data || {};
}

function enhancementBody(videoUrl, overrides = {}) {
    let configured = {};
    const raw = process.env.BYTEPLUS_VOD_EXR_REQUEST_JSON?.trim();
    if (raw) {
        try { configured = JSON.parse(raw); } catch { throw new Error('BYTEPLUS_VOD_EXR_REQUEST_JSON must be valid JSON.'); }
    }
    return {
        scene: 'common',
        tool_version: 'professional',
        resolution: process.env.BYTEPLUS_VOD_EXR_RESOLUTION?.trim() || '4k',
        bitrate_level: 'high',
        fps: 24,
        project: process.env.BYTEPLUS_VOD_PROJECT?.trim() || 'default',
        persist: process.env.BYTEPLUS_VOD_PERSIST !== 'false',
        bit_depth: 16,
        output_format: 'EXR',
        ...configured,
        ...overrides,
        video_url: videoUrl,
    };
}

export function buildEnhancementRequest({ videoUrl = 'queued-source' } = {}) {
    return enhancementBody(videoUrl);
}

export function validateSourceUrl(value) {
    let parsed;
    try { parsed = new URL(value); } catch { return false; }
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    return /\.(bytepluses\.com|volces\.com|volcvideo\.com)$/i.test(parsed.hostname);
}

export async function submitEnhancement({ videoUrl, requestBody = null }) {
    const auth = headers();
    if (!auth) throw Object.assign(new Error('BYTEPLUS_VOD_MEDIAKIT_API_KEY is not configured.'), { status: 503 });
    if (!validateSourceUrl(videoUrl)) throw Object.assign(new Error('The source video must be a public BytePlus HTTPS media URL.'), { status: 400 });
    const configuredPath = process.env.BYTEPLUS_VOD_MEDIAKIT_ENHANCE_PATH?.trim() || DEFAULT_PATH;
    const path = configuredPath.startsWith('/') ? configuredPath : `/${configuredPath}`;
    const data = await requestJson(`${baseUrl()}${path}`, {
        method: 'POST', headers: auth, body: JSON.stringify(enhancementBody(videoUrl, requestBody || {})),
    });
    const accepted = data.data || data;
    if (!accepted.task_id) throw Object.assign(new Error('BytePlus did not return an enhancement task ID.'), { status: 502 });
    return { taskId: String(accepted.task_id), requestId: accepted.request_id || data.request_id || null };
}

export async function pollEnhancement(providerTaskId) {
    const auth = headers();
    if (!auth) throw Object.assign(new Error('BYTEPLUS_VOD_MEDIAKIT_API_KEY is not configured.'), { status: 503 });
    const data = await requestJson(`${baseUrl()}/tasks/${encodeURIComponent(providerTaskId)}`, { method: 'GET', headers: auth });
    const task = data.data || data;
    const status = String(task.status || '').toLowerCase();
    if (status === 'completed' || status === 'succeeded') {
        const result = task.result || task.content || task;
        return {
            status: 'succeeded',
            url: result.video_url || result.source_url || result.url || task.video_url || task.source_url || task.url || null,
            expiresAt: task.expires_at || null,
            metadata: { duration: result.duration ?? result.duration_seconds ?? null, resolution: result.resolution || null, fps: result.fps ?? null, format: result.output_format || result.format || 'exr' },
        };
    }
    if (status === 'failed' || status === 'cancelled' || status === 'expired') {
        return { status: 'failed', error: task.error?.message || task.error?.Message || status };
    }
    return { status: 'processing' };
}
