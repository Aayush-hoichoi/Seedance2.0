'use client';

// Generation-job persistence: every Generate creates a job that lives in
// localStorage, so the history (finished videos) and in-flight tasks survive a
// page reload. In-flight jobs are resumed by re-polling their ModelArk taskId —
// the task itself keeps rendering server-side regardless of the page.

const KEY = 'seedance.jobs.v1';
const MAX_JOBS = 60;

export function loadJobs() {
    if (typeof window === 'undefined') return [];
    try {
        const raw = window.localStorage.getItem(KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

export function saveJobs(jobs) {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(KEY, JSON.stringify(jobs.slice(0, MAX_JOBS)));
    } catch {
        // Quota/private-mode failures just lose persistence, never the session.
    }
}

// taskId → prompt map, kept separately and never pruned by history logic, so
// server-restored cards can recover their captions (the list API doesn't echo
// prompts). Capped to the most recent 200 entries.
const PROMPTS_KEY = 'seedance.prompts.v1';
const MAX_PROMPTS = 200;

export function loadPrompts() {
    if (typeof window === 'undefined') return {};
    try {
        const raw = window.localStorage.getItem(PROMPTS_KEY);
        const obj = raw ? JSON.parse(raw) : {};
        return obj && typeof obj === 'object' ? obj : {};
    } catch {
        return {};
    }
}

export function savePrompt(taskId, prompt) {
    if (typeof window === 'undefined' || !taskId) return;
    try {
        const map = loadPrompts();
        map[taskId] = prompt;
        const keys = Object.keys(map);
        if (keys.length > MAX_PROMPTS) {
            for (const k of keys.slice(0, keys.length - MAX_PROMPTS)) delete map[k];
        }
        window.localStorage.setItem(PROMPTS_KEY, JSON.stringify(map));
    } catch {
        // best-effort
    }
}

// Drop a task's cached prompt — called when a history card is deleted, so the
// server-merge on reload can't resurrect it from this local map.
export function removePrompt(taskId) {
    if (typeof window === 'undefined' || !taskId) return;
    try {
        const map = loadPrompts();
        if (!(taskId in map)) return;
        delete map[taskId];
        window.localStorage.setItem(PROMPTS_KEY, JSON.stringify(map));
    } catch {
        // best-effort
    }
}

export function newJob({ prompt, model, userPrompt = null, style = null, modeId = null, refs = null }) {
    return {
        id: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        prompt, // what was actually sent to Seedance (GPT-4o brief in styled modes)
        userPrompt, // the user's raw prompt, when a styled mode restructured it
        style,
        modeId, // the studio mode that created this job — restored on Reuse
        refs, // reference assets attached at creation: [{ kind, role, url, previewUrl, name, assetId }]
        model,
        status: 'submitting', // submitting|queued|running|done|error
        taskId: null,
        videoUrl: null,
        error: null,
        liked: false, // user "like" mark in the history rail (local to this device)
        createdAt: Date.now(),
    };
}
