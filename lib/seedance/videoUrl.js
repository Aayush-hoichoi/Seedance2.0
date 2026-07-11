'use client';

// Fresh playable URL for a finished generation whose stored link has expired
// (ModelArk task URLs die in ~24h, TOS presigns in ≤7 days). Same fallback
// chain the gallery player uses: archived TOS copy (deterministic key,
// re-presigned server-side, lives forever) → live ModelArk task record →
// null (truly gone). `fetchFn` is injectable for tests.

import { archiveKeyForTask } from './archiveKey.mjs';

// Presigning is pure HMAC math — it "succeeds" even for objects that were
// never archived — so probe the URL with a headers-only GET before trusting
// it. 'maybe' = network/CORS blocked the probe: can't tell dead from alive.
async function probeUrl(url, fetchFn) {
    try {
        const controller = new AbortController();
        const res = await fetchFn(url, { signal: controller.signal });
        controller.abort(); // headers are enough — don't download the video
        return res.ok ? 'ok' : 'missing';
    } catch {
        return 'maybe';
    }
}

export async function resolveFreshVideoUrl(taskId, fetchFn = (...a) => fetch(...a)) {
    const key = archiveKeyForTask(taskId);
    if (!key) return null;

    let archived = null;
    try {
        const res = await fetchFn(`/api/byteplus/archive?key=${encodeURIComponent(key)}`);
        const d = res.ok ? await res.json() : null;
        archived = d?.url || null;
    } catch { /* presign route unreachable — fall through to the live task */ }

    const state = archived ? await probeUrl(archived, fetchFn) : 'missing';
    if (state === 'ok') return archived;

    let live = null;
    try {
        const res = await fetchFn(`/api/byteplus/contents/generations/tasks/${encodeURIComponent(taskId)}`);
        const d = res.ok ? await res.json() : null;
        live = d?.content?.video_url || null;
    } catch { /* task record aged out or proxy down */ }

    // An unverifiable archived URL ('maybe') is still worth a try when the
    // live record has nothing — the player's onError makes the final call.
    return live || (state === 'maybe' ? archived : null);
}
