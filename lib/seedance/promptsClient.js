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
