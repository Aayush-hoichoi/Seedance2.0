'use client';

// Sends the user's raw prompt to GPT-4o (via our /api/openai/enhance route),
// which restructures it into the strict production brief the selected style
// (Motion Capture / Green Screen) requires before it goes to Seedance.

export async function enhancePrompt({ style, prompt, assets }) {
    let res;
    try {
        res = await fetch('/api/openai/enhance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ style, prompt, assets }),
        });
    } catch {
        throw new Error('Could not reach the app server to restructure the prompt.');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `Prompt restructuring failed (${res.status}).`);
    if (!data?.prompt) throw new Error('Prompt restructuring returned an empty result.');
    return data.prompt;
}
