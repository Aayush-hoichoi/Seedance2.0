// Per-project style memory ("the project brain"). Three shows on this platform
// — MAHISHASUR MARDINI, Maahi and The Good Samaritan — keep their look
// consistent today by having operators hand-paste a style block into every
// prompt. The history says that does not hold: Mahishasur ran three mutually
// contradictory style bibles in three weeks (the dead one scored 0 likes in 58
// uses), Maahi spells its one style token eight different ways and its hero's
// colour six, and operators resorted to labelling prompts "[STYLE —
// TRIPLE-STAMPED]" and pasting the render line three times to make it stick.
//
// So the style moves server-side: stored per project in projects.style, applied
// here, inside the gateway, where the studio, the MCP tools and any direct API
// caller all pass through. A project with no style row is untouched — NULL is
// the opt-out, which is why there is no feature flag.
//
// Pure and dependency-free so it unit-tests under `node --test` like the rest of
// lib/gateway.

// Ceiling for the COMPOSED prompt (user text + style block), not the user's
// input — validateImageRequest caps that separately at 5000. This must sit far
// above typical team prompts or the style silently fails to attach exactly on
// the shots that need it most: the shows' median prompts run 1.5–3.3k chars
// and the ledger holds accepted provider prompts past 26k, so 5000 here made
// styling a coin flip. The section budget below still trims on overflow.
const MAX_PROMPT = 30_000;

// The user's prompt and the project block disagree constantly by design — the
// prompt says "he turns and walks away", the block says "locked-off static
// camera". Left implicit, the model splits the difference on both. Naming which
// one owns what is the difference between a style layer and a contradiction.
const HEADER = '[PROJECT STYLE — LOCKED]\nThe text above defines this shot\'s content, action and dialogue. The rules below define rendering style, palette and character identity. Where the two conflict on LOOK, these rules win; where they conflict on ACTION, the text above wins. Do not restate these rules in the output.';

function looksResolved(style, requested) {
    const looks = style.looks && typeof style.looks === 'object' ? style.looks : {};
    const key = requested || style.defaultLook || Object.keys(looks)[0];
    return key && looks[key] ? { key, look: looks[key] } : null;
}

// Operators will keep pasting the old boilerplate for weeks after this ships,
// and a doubled style block is worse than none — the model weights the repeat.
// Signature match on the brief's opening rather than the whole thing, because
// what gets pasted is always a near-miss variant of it.
// ponytail: prefix match, 48 chars. If the variants drift further, give a look
// an explicit `signature` field and match on that instead.
function alreadyStyled(prompt, brief) {
    const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const sig = norm(brief).slice(0, 48);
    return sig.length >= 16 && norm(prompt).includes(sig);
}

// Only the characters this shot actually names. Maahi's cast sheet is seven
// characters of ~40 words each; injecting all of them on a two-hander would
// spend the whole prompt budget describing people who are not in the frame.
function namedCharacters(prompt, characters) {
    if (!characters || typeof characters !== 'object') return [];
    const hay = prompt.toLowerCase();
    return Object.entries(characters)
        .filter(([name, desc]) => desc && hay.includes(name.toLowerCase()))
        .map(([name, desc]) => `${name}: ${desc}`);
}

/**
 * Compose the prompt actually sent to the provider.
 *
 * @param {string} prompt      the user's prompt
 * @param {object|null} style  the projects.style jsonb
 * @param {{look?: string|null, maxPrompt?: number}} opts
 *        look: per-generation override; 'none' opts this one generation out.
 * @returns {{prompt: string, applied: boolean, look: string|null, version: number|null}}
 */
export function composeStyledPrompt(prompt, style, { look = null, maxPrompt = MAX_PROMPT } = {}) {
    const off = { prompt, applied: false, look: null, version: null };
    if (typeof prompt !== 'string' || !prompt.trim()) return off;
    if (!style || typeof style !== 'object' || style.enabled === false) return off;
    if (look === 'none') return off;

    const resolved = looksResolved(style, look);
    if (!resolved) return off;
    const brief = typeof resolved.look.brief === 'string' ? resolved.look.brief.trim() : '';
    if (!brief) return off;

    const sections = [];
    if (!alreadyStyled(prompt, brief)) sections.push(brief);
    const cast = namedCharacters(prompt, style.characters);
    if (cast.length) sections.push(`CHARACTER LOCK — match the references exactly:\n${cast.join('\n')}`);
    const negatives = typeof resolved.look.negatives === 'string' ? resolved.look.negatives.trim() : '';
    if (negatives) sections.push(`NEVER: ${negatives}`);
    if (!sections.length) return { ...off, look: resolved.key, version: style.version ?? null };

    // Budget: drop the lowest-priority section (negatives, then cast) rather
    // than overrun the provider's prompt cap. Mahi's prompts already run 1,200+
    // characters before anything is added, so this is not hypothetical.
    let composed = null;
    for (let end = sections.length; end > 0; end -= 1) {
        const candidate = `${prompt.trim()}\n\n${HEADER}\n\n${sections.slice(0, end).join('\n\n')}`;
        if (candidate.length <= maxPrompt) { composed = candidate; break; }
    }
    if (!composed) return off; // even the brief alone does not fit — leave the prompt alone

    return { prompt: composed, applied: true, look: resolved.key, version: style.version ?? null };
}

/**
 * Apply a composed prompt to a sanitized image request in the shape
 * enqueueGeneration persists.
 *
 * Both fields must move together: the Google adapter reads request.parts and
 * prefers it over request.prompt, while byteplus/kie/openai read request.prompt.
 * Rewriting one silently no-ops for half the model catalog.
 */
export function applyStyledImagePrompt(request, styledPrompt) {
    if (!request || styledPrompt === request.prompt) return request;
    const next = { ...request, prompt: styledPrompt };
    if (Array.isArray(request.parts)) {
        let replaced = false;
        next.parts = request.parts.map((p) => {
            if (!replaced && p && typeof p.text === 'string') { replaced = true; return { text: styledPrompt }; }
            return p;
        });
        if (!replaced) next.parts = [{ text: styledPrompt }, ...next.parts];
    }
    return next;
}

/**
 * Apply a composed prompt to a ModelArk video request's content[] array.
 * Returns the new content array, or the original when there is no text entry.
 */
export function applyStyledVideoPrompt(content, styledPrompt) {
    if (!Array.isArray(content)) return content;
    let replaced = false;
    const next = content.map((c) => {
        if (!replaced && c?.type === 'text') { replaced = true; return { ...c, text: styledPrompt }; }
        return c;
    });
    return replaced ? next : content;
}

// Bounds for a stored style. A brief is appended to every prompt the project
// sends, so an oversized one does not fail loudly — it quietly eats the prompt
// budget and gets dropped by composeStyledPrompt's section budget, which looks
// like "the style randomly stopped working". Cap it at save time instead.
const STYLE_LIMITS = { looks: 12, brief: 4000, negatives: 2000, characters: 40, character: 1500, key: 64, name: 80 };

/**
 * Validate a style object before it is stored. Returns an error string, or null
 * when the object is safe to persist.
 */
export function styleError(style) {
    if (style === null) return null; // clearing is always allowed
    if (!style || typeof style !== 'object' || Array.isArray(style)) return 'Style must be an object or null.';

    const looks = style.looks;
    if (!looks || typeof looks !== 'object' || Array.isArray(looks)) return 'Style must have a looks object.';
    const keys = Object.keys(looks);
    if (!keys.length) return 'Add at least one look, or clear the style entirely.';
    if (keys.length > STYLE_LIMITS.looks) return `At most ${STYLE_LIMITS.looks} looks per project.`;

    for (const key of keys) {
        if (key.length > STYLE_LIMITS.key) return `Look id "${key.slice(0, 20)}…" is too long.`;
        // 'none' is the reserved opt-out value callers pass per generation; a
        // look actually named 'none' could never be selected.
        if (key === 'none') return '"none" is reserved — it means "skip the project style".';
        const look = looks[key];
        if (!look || typeof look !== 'object') return `Look "${key}" is malformed.`;
        if (typeof look.brief !== 'string' || !look.brief.trim()) return `Look "${key}" needs a brief.`;
        if (look.brief.length > STYLE_LIMITS.brief) return `Look "${key}" brief is too long (max ${STYLE_LIMITS.brief} characters).`;
        if (look.negatives != null && typeof look.negatives !== 'string') return `Look "${key}" negatives must be text.`;
        if ((look.negatives?.length ?? 0) > STYLE_LIMITS.negatives) return `Look "${key}" negatives are too long (max ${STYLE_LIMITS.negatives} characters).`;
        if (look.name != null && String(look.name).length > STYLE_LIMITS.name) return `Look "${key}" name is too long.`;
    }
    if (style.defaultLook != null && !looks[style.defaultLook]) {
        return `Default look "${style.defaultLook}" is not one of this project's looks.`;
    }

    const characters = style.characters;
    if (characters != null) {
        if (typeof characters !== 'object' || Array.isArray(characters)) return 'Characters must be an object.';
        const names = Object.keys(characters);
        if (names.length > STYLE_LIMITS.characters) return `At most ${STYLE_LIMITS.characters} characters per project.`;
        for (const name of names) {
            if (typeof characters[name] !== 'string') return `Character "${name}" must have a text description.`;
            if (characters[name].length > STYLE_LIMITS.character) return `Character "${name}" description is too long (max ${STYLE_LIMITS.character} characters).`;
        }
    }
    return null;
}

/**
 * What a client needs to render the style control: which looks exist and which
 * is the default. Deliberately NOT the brief text — a project's briefs run to
 * several KB, the project list returns every project the caller can see, and no
 * client needs the prose to draw a dropdown.
 *
 * Returns null when the project has no usable style, which is what lets a
 * client treat "no style" and "styles off" identically.
 */
export function styleSummary(style) {
    if (!style || typeof style !== 'object' || style.enabled === false) return null;
    const looks = style.looks && typeof style.looks === 'object' ? style.looks : {};
    const items = Object.entries(looks)
        .filter(([, look]) => look && typeof look.brief === 'string' && look.brief.trim())
        .map(([key, look]) => ({ key, name: look.name || key }));
    if (!items.length) return null;
    const defaultLook = looks[style.defaultLook] ? style.defaultLook : items[0].key;
    return { version: style.version ?? null, defaultLook, looks: items };
}

/** The prompt a ModelArk video request carries, or '' when it has none. */
export function videoPromptOf(content) {
    if (!Array.isArray(content)) return '';
    const part = content.find((c) => c?.type === 'text' && typeof c.text === 'string');
    return part ? part.text : '';
}
