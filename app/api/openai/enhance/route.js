import { NextResponse } from 'next/server';
import { STYLES } from '../../../../lib/openai/styleBriefs.js';
import { isRefusal } from '../../../../lib/openai/refusal.mjs';

// Restructures a raw user prompt into the strict production brief a style
// requires, via the enhancer model. POST { style, prompt, assets: [{label, kind, name}] }
// → { prompt }. The OpenAI key never leaves the server.

export const runtime = 'nodejs';
export const maxDuration = 60;

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.OPENAI_ENHANCE_MODEL?.trim() || 'gpt-5.6-luna';

function bad(message, status = 400) {
    return NextResponse.json({ error: message }, { status });
}

// Cheap abuse guard for a public deployment: browser calls from our own pages
// carry a same-origin Origin/Referer; reject obvious cross-site/scripted use.
// (Not real auth — a determined caller can spoof headers — but it keeps the
// OpenAI key from being a free-for-all proxy.)
function sameOrigin(request) {
    const source = request.headers.get('origin') || request.headers.get('referer');
    if (!source) return true; // same-origin GET-less fetches may omit both
    try {
        return new URL(source).host === request.headers.get('host');
    } catch {
        return false;
    }
}

export async function POST(request) {
    if (!sameOrigin(request)) return bad('Forbidden.', 403);

    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
        return bad('OPENAI_API_KEY is not configured — add it to .env.local (and the Vercel env), then redeploy/restart.', 500);
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return bad('Invalid JSON body.');

    const style = STYLES[body.style];
    if (!style) return bad(`Unknown style "${body.style}". Expected one of: ${Object.keys(STYLES).join(', ')}.`);

    // No app-side length cap — the only ceiling is the enhancer model's own context window,
    // and OpenAI returns a clear error if a prompt ever exceeds it.
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return bad('Prompt is empty — describe what should change in the video.');

    const assets = Array.isArray(body.assets) ? body.assets : [];
    const assetLines = assets
        .filter((a) => a && typeof a.label === 'string')
        .map((a) => `- ${a.label} (${a.kind || 'asset'})${a.name ? ` — file: ${a.name}` : ''}`)
        .join('\n');

    // Optional cinematic camera direction (Cinematic Cameras image mode). Each
    // field is a short human-labeled string the system prompt weaves into the
    // image prompt; coerce + cap so it's a bounded block, not free-form input.
    const camStr = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);
    const camera = body.camera && typeof body.camera === 'object' ? body.camera : null;
    const cameraLines = camera
        ? [
            camStr(camera.camera) && `- Camera: ${camStr(camera.camera)}`,
            camStr(camera.lens) && `- Lens: ${camStr(camera.lens)}`,
            camStr(camera.focalLength) && `- Focal length: ${camStr(camera.focalLength)}`,
            camStr(camera.aperture) && `- Aperture: ${camStr(camera.aperture)}`,
        ].filter(Boolean).join('\n')
        : '';

    const userMessage = [
        assetLines
            // The labels are @-tokens (@Image1, @Video1). Seedance binds a
            // reference ONLY when that token survives into the final prompt —
            // strip the @ and the model gets the assets with nothing tying them
            // to the words. Restructuring used to drop them, which is how four
            // attached references produced a video that honoured none of them.
            ? `Attached assets. You MUST refer to each one by its exact @-token, `
              + `character for character, including the leading "@". Never rewrite `
              + `"@Image1" as "Image 1", "the first image", or a description — the `
              + `token is what binds the asset to your words. Keep every token that `
              + `appears in the user's request, and say what each asset provides `
              + `(appearance, motion, timbre):\n${assetLines}`
            : 'No assets are attached.',
        cameraLines ? `Camera settings:\n${cameraLines}` : null,
        `User request:\n${prompt}`,
    ].filter(Boolean).join('\n\n');

    let res;
    try {
        res = await fetch(OPENAI_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: MODEL,
                // gpt-5.x rejects `max_tokens` and any temperature but the
                // default; `max_completion_tokens` also works on gpt-4o, so
                // this shape is valid for whatever OPENAI_ENHANCE_MODEL names.
                // The cap covers reasoning + brief — never truncate the brief.
                max_completion_tokens: 16384,
                // Restructuring, not deep reasoning — keeps the call ~3s.
                // gpt-4o and older reject the argument outright.
                ...(MODEL.startsWith('gpt-5') ? { reasoning_effort: 'low' } : {}),
                messages: [
                    { role: 'system', content: style.system },
                    { role: 'user', content: userMessage },
                ],
            }),
        });
    } catch {
        return bad('Could not reach OpenAI — check the server\'s network access.', 502);
    }

    const data = await res.json().catch(() => null);
    if (!res.ok) {
        // Don't forward OpenAI's error text — it can leak account/quota details.
        console.error('openai enhance failed:', res.status, data?.error?.message || data?.error || '');
        return bad(`Prompt restructuring failed (OpenAI ${res.status}) — try again.`, 502);
    }

    const finishReason = data?.choices?.[0]?.finish_reason;
    const enhanced = data?.choices?.[0]?.message?.content?.trim();

    // The enhancer declined this content (its moderation, not ours). Don't forward the
    // refusal sentence as if it were a brief — signal it so the caller can fall
    // back to the user's own prompt.
    if (isRefusal({ text: enhanced, finishReason })) {
        return NextResponse.json(
            { refused: true, error: 'The prompt enhancer declined to restructure this prompt — generating from your prompt as-is.' },
            { status: 422 },
        );
    }

    if (!enhanced) return bad('OpenAI returned an empty prompt.', 502);

    return NextResponse.json({ prompt: enhanced, style: body.style, model: MODEL });
}
