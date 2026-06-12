import { NextResponse } from 'next/server';
import { STYLES } from '../../../../lib/openai/styleBriefs.js';

// Restructures a raw user prompt into the strict production brief a style
// requires, via GPT-4o. POST { style, prompt, assets: [{label, kind, name}] }
// → { prompt }. The OpenAI key never leaves the server.

export const runtime = 'nodejs';
export const maxDuration = 60;

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.OPENAI_ENHANCE_MODEL?.trim() || 'gpt-4o';
const MAX_PROMPT_CHARS = 4000;

function bad(message, status = 400) {
    return NextResponse.json({ error: message }, { status });
}

export async function POST(request) {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
        return bad('OPENAI_API_KEY is not configured — add it to .env.local (and the Vercel env), then redeploy/restart.', 500);
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return bad('Invalid JSON body.');

    const style = STYLES[body.style];
    if (!style) return bad(`Unknown style "${body.style}". Expected one of: ${Object.keys(STYLES).join(', ')}.`);

    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return bad('Prompt is empty — describe what should change in the video.');
    if (prompt.length > MAX_PROMPT_CHARS) return bad(`Prompt is too long (${prompt.length} chars, max ${MAX_PROMPT_CHARS}).`);

    const assets = Array.isArray(body.assets) ? body.assets : [];
    const assetLines = assets
        .filter((a) => a && typeof a.label === 'string')
        .map((a) => `- ${a.label} (${a.kind || 'asset'})${a.name ? ` — file: ${a.name}` : ''}`)
        .join('\n');

    const userMessage = [
        assetLines ? `Attached assets (reference these by their exact labels):\n${assetLines}` : 'No assets are attached.',
        `User request:\n${prompt}`,
    ].join('\n\n');

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
                temperature: 0.3,
                max_tokens: 3500,
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
        const detail = data?.error?.message || `OpenAI request failed (${res.status}).`;
        return bad(detail, 502);
    }

    const enhanced = data?.choices?.[0]?.message?.content?.trim();
    if (!enhanced) return bad('OpenAI returned an empty prompt.', 502);

    return NextResponse.json({ prompt: enhanced, style: body.style, model: MODEL });
}
