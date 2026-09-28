// Optional AI prompt polish for workflow generations. With the picker's
// "AI prompt polish" toggle on, the user's short prompt is rewritten by the
// enhancer model IN the attached workflow's style — richer shot description,
// style-true vocabulary — before the gateway's deterministic style merge
// stamps the hard rules on top. Polish is best-effort by contract: any
// failure (no key, model down, junk output) returns null and the caller
// generates from the raw prompt; a generation is never blocked on polish.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_OUT = 2000; // characters — a polished prompt is a shot brief, not an essay

export function buildPolishMessages(style, prompt) {
    const look = style.looks?.[style.defaultLook] || Object.values(style.looks || {})[0] || {};
    const characters = Object.keys(style.characters || {});
    return [
        {
            role: 'system',
            content: [
                'You rewrite a user\'s short video/image prompt into a rich, production-ready shot description that fits a fixed visual style. Rules:',
                '- KEEP the user\'s content, subjects and action exactly — never add new characters, locations or events they did not ask for.',
                '- Expand camera, framing, movement, lighting and mood using the style below.',
                '- Plain prose, no headings, no lists, no quotes around the result.',
                `- At most ${MAX_OUT} characters. Return ONLY the rewritten prompt.`,
                `STYLE: ${typeof look.brief === 'string' ? look.brief : ''}`,
                ...(typeof look.negatives === 'string' && look.negatives ? [`NEVER: ${look.negatives}`] : []),
                ...(characters.length ? [`Known characters (use their names verbatim if the user mentions them): ${characters.join(', ')}`] : []),
            ].join('\n'),
        },
        { role: 'user', content: prompt },
    ];
}

export async function polishPrompt({ style, prompt }) {
    try {
        const apiKey = process.env.OPENAI_API_KEY?.trim();
        if (!apiKey || !style || typeof prompt !== 'string' || !prompt.trim()) return null;
        const model = process.env.OPENAI_ENHANCE_MODEL?.trim() || 'gpt-5.6-luna';
        const res = await fetch(OPENAI_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages: buildPolishMessages(style, prompt) }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        const out = data?.choices?.[0]?.message?.content?.trim();
        return out ? out.slice(0, MAX_OUT) : null;
    } catch {
        return null;
    }
}
