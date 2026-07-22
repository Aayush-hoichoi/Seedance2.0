'use client';

// Sends the user's raw prompt to the enhancer (via our /api/openai/enhance route),
// which restructures it into the strict production brief the selected style
// (Motion Capture / Green Screen) requires before it goes to Seedance.
//
// Returns { prompt, refused, reason }:
//   • refused === false → `prompt` is the restructured brief.
//   • refused === true  → the enhancer declined this content; `prompt` is null and the
//     caller should fall back to the user's own prompt (`reason` explains why).
// Throws only on real failures (network / missing key / server error).

export async function enhancePrompt({ style, prompt, assets, camera }) {
    let res;
    try {
        res = await fetch('/api/openai/enhance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ style, prompt, assets, camera }),
        });
    } catch {
        throw new Error('Could not reach the app server to restructure the prompt.');
    }
    const data = await res.json().catch(() => null);
    if (res.status === 422 && data?.refused) {
        return { prompt: null, refused: true, reason: data.error || null };
    }
    if (!res.ok) throw new Error(data?.error || `Prompt restructuring failed (${res.status}).`);
    if (!data?.prompt) throw new Error('Prompt restructuring returned an empty result.');
    return { prompt: data.prompt, refused: false, reason: null };
}
