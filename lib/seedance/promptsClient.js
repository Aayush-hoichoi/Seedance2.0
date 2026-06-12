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
