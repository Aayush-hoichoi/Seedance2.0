// "@CharacterName" mention tokens for the project cast (Characters tab).
//
// Unlike the positional @Image1/@Video1 tokens (lib/seedance/tags.js), a cast
// token names a SAVED character. Typing "@" lists the project's characters;
// picking one inserts "@Name" into the prompt and attaches the character's
// stored reference image — no upload. Before the API sees the prompt the token
// is rewritten: the bare name stays (the gateway's CHARACTER LOCK injection
// matches on it), and when the character's reference is attached as a
// positional tag, "(@Image N)" is appended so Seedance binds the words to the
// asset (tags.js documents why the @ must survive: without it the model
// free-generates from the prose).

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One regex matching @Name for every cast name — longest names first so
// "@Riya Sharma" wins over a cast member named "Riya". Case-insensitive.
// null when there is no cast (callers skip the pass entirely).
export function castTokenRe(names) {
    const list = (names || []).filter((n) => typeof n === 'string' && n.trim());
    if (!list.length) return null;
    const alts = [...list].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
    return new RegExp(`@(${alts})`, 'gi');
}

// Case/space-insensitive mention filter: "@riyash" matches "Riya Sharma".
export function filterCast(characters, query) {
    const q = (query || '').toLowerCase().replace(/\s+/g, '');
    if (!q) return characters;
    return characters.filter((c) => c.name.toLowerCase().replace(/\s+/g, '').startsWith(q));
}

/**
 * Rewrite "@Name" cast tokens for the API.
 *
 * @param {string} prompt
 * @param {Array<{name: string}>} characters  the project cast
 * @param {Array<{name: string, label: string}>|null} tags
 *        positional tags (buildTags) to bind against, or null to emit bare
 *        names only (image mode, batched video generations).
 * @returns {string}
 */
export function bindCastTokens(prompt, characters, tags = null) {
    const re = castTokenRe(characters.map((c) => c.name));
    if (!re || !prompt) return prompt;
    return prompt.replace(re, (_, name) => {
        const canonical = characters.find((c) => c.name.toLowerCase() === name.toLowerCase())?.name || name;
        const tag = tags?.find((t) => t.name === canonical);
        return tag ? `${canonical} (@${tag.label})` : canonical;
    });
}
