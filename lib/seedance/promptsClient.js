'use client';

// Client for the Neon-backed prompt-pair store (/api/seedance/prompts):
// saves the user's raw prompt + the GPT-4o-generated brief per taskId, and
// fetches them back so any browser can show the comparison tabs.

export function savePromptRecord({ taskId, userPrompt, generatedPrompt, style, refs = null }) {
    // Best-effort: history UX must never block or fail a generation.
    return fetch('/api/seedance/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, userPrompt, generatedPrompt, style, refs }),
    }).catch(() => null);
}

// Persist a history item's "like" mark to Neon, keyed by taskId. Resolves to
// true on a confirmed save, false otherwise — the caller reverts its optimistic
// UI when this fails, so the heart never lies about what's in the database.
export async function setLikeRecord({ taskId, liked }) {
    if (!taskId) return false;
    try {
        const res = await fetch('/api/seedance/likes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId, liked }),
        });
        return res.ok;
    } catch {
        return false;
    }
}

// Persist a history item's "bin" (soft-delete) state to Neon, keyed by taskId,
// so a generation binned in one browser stays hidden in every browser. Resolves
// { ok, error } — on failure (including "not yours to bin") the caller reverts
// its optimistic UI and shows the reason.
export async function setBinRecord({ taskId, deleted }) {
    if (!taskId) return { ok: false, error: 'No task id yet.' };
    try {
        const res = await fetch('/api/seedance/bin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId, deleted }),
        });
        if (res.ok) return { ok: true };
        const d = await res.json().catch(() => null);
        return { ok: false, error: d?.error || null };
    } catch {
        return { ok: false, error: null };
    }
}

// Permanently remove a generation's record from Neon (keyed by taskId), so a
// deleted history card stays gone after a reload. Resolves { ok, error } — the
// caller warns with the reason when it fails (e.g. only the creator may delete).
export async function deletePromptRecord({ taskId }) {
    if (!taskId) return { ok: false, error: 'No task id yet.' };
    try {
        const res = await fetch(`/api/seedance/prompts?taskId=${encodeURIComponent(taskId)}`, { method: 'DELETE' });
        if (res.ok) return { ok: true };
        const d = await res.json().catch(() => null);
        return { ok: false, error: d?.error || null };
    } catch {
        return { ok: false, error: null };
    }
}

// taskIds → { [taskId]: { task_id, style, user_prompt, generated_prompt, refs } }
export async function fetchPromptRecords(taskIds) {
    const ids = [...new Set((taskIds || []).filter(Boolean))];
    if (!ids.length) return {};
    try {
        const res = await fetch(`/api/seedance/prompts?taskIds=${encodeURIComponent(ids.join(','))}`);
        const data = await res.json().catch(() => null);
        if (!res.ok || !Array.isArray(data?.items)) return {};
        return Object.fromEntries(data.items.map((r) => [r.task_id, r]));
    } catch {
        return {};
    }
}
