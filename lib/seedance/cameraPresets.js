// Custom cinematic setups the user saved, persisted per-device in localStorage
// — mirrors lib/seedance/jobs.js. Each entry: { id, name, cameraId, lensId,
// focalLength, aperture }. Device-local UI sugar; no DB (same trust level as the
// jobs/prompts already stored client-side).

const KEY = 'seedance.cameraPresets.v1';
const MAX = 50;

export function loadPresets() {
    try {
        if (typeof localStorage === 'undefined') return [];
        const raw = localStorage.getItem(KEY);
        if (!raw) return [];
        const list = JSON.parse(raw);
        return Array.isArray(list) ? list.slice(0, MAX) : [];
    } catch {
        return []; // corrupt JSON / private mode
    }
}

export function savePresets(list) {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(KEY, JSON.stringify((Array.isArray(list) ? list : []).slice(0, MAX)));
    } catch {
        /* private mode / quota — presets are best-effort */
    }
}
