// Positional reference tags for Seedance 2.0 multimodal mode.
//
// BytePlus references reference-assets in the prompt by "asset type + index" —
// "Image 1", "Video 1", "Audio 1" — where the index is the asset's position
// among the SAME type in the content array (NOT the asset id). We surface those
// as @-mentions in the prompt and as badges on the thumbnails, and the order
// here is kept identical to buildPayload's content order so the numbers line up.

const KIND_LABEL = { image: 'Image', video: 'Video', audio: 'Audio' };
const TAG_ROLES = ['reference_image', 'reference_video', 'reference_audio'];

// Only the multimodal reference mode uses positional tags (i2v first/last frame
// are positional by role, not by prompt mention).
export function modeSupportsTags(mode) {
    return mode.media.some((s) => TAG_ROLES.includes(s.role));
}

// Ordered tag list from mediaByRole: [{ kind, role, indexInRole, number, label }].
export function buildTags(mode, mediaByRole) {
    const counters = { image: 0, video: 0, audio: 0 };
    const tags = [];
    for (const slot of mode.media) {
        if (!TAG_ROLES.includes(slot.role)) continue;
        const items = mediaByRole[slot.role] || [];
        items.forEach((item, indexInRole) => {
            counters[slot.kind] += 1;
            tags.push({
                kind: slot.kind,
                role: slot.role,
                indexInRole,
                number: counters[slot.kind],
                label: `${KIND_LABEL[slot.kind]} ${counters[slot.kind]}`,
                name: item.name,
            });
        });
    }
    return tags;
}

// Badge label for a specific (role, indexInRole) — used on thumbnails.
export function tagLabelFor(tags, role, indexInRole) {
    const t = tags.find((x) => x.role === role && x.indexInRole === indexInRole);
    return t ? t.label : null;
}

// Prompt token for a tag: "@Image1". Users type/insert these; the prompt is
// normalised to BytePlus's "Image 1" wording only when the payload is built.
export function tagToken(tag) {
    return `@${tag.label.replace(' ', '')}`;
}

// Matches @Image1 / @video 2 / @AUDIO3 — any case, optional space.
export const TOKEN_RE = /@(image|video|audio)\s?(\d+)/gi;

const KIND_CAP = { image: 'Image', video: 'Video', audio: 'Audio' };

// Auto-correct: rewrite every @-token (whatever the casing/spacing the user
// typed) into the exact "Image N" text the Seedance API expects.
export function normalizePromptForApi(prompt) {
    return prompt.replace(TOKEN_RE, (_, kind, n) => `${KIND_CAP[kind.toLowerCase()]} ${n}`);
}

// Inverse of normalizePromptForApi: rewrite the bare "Image N" wording back
// into "@ImageN" mention tokens so the cyan chips repaint. Used by Reuse, where
// the stored prompt was already normalised for the API and lost its @-tokens.
// Only references that actually exist (N ≤ attached count for that kind) are
// re-tokenised, so prose that happens to read "Image 1" is left untouched.
export function restorePromptTokens(prompt, tags) {
    if (!prompt) return prompt;
    const max = tags.reduce((acc, t) => ({ ...acc, [t.kind]: Math.max(acc[t.kind] || 0, t.number) }), {});
    return prompt.replace(/\b(Image|Video|Audio)\s+(\d+)\b/g, (whole, kind, n) =>
        Number(n) <= (max[kind.toLowerCase()] || 0) ? `@${kind}${n}` : whole,
    );
}

// Normalise "Image 1" → "image1" so @img / @image1 both match.
function normalize(s) {
    return s.toLowerCase().replace(/\s+/g, '');
}

// Filter tags for the @-mention menu by the text typed after "@".
export function filterTags(tags, query) {
    const q = normalize(query);
    if (!q) return tags;
    return tags.filter((t) => normalize(t.label).startsWith(q) || normalize(t.kind).startsWith(q));
}

// Guard: every "Image N / Video N / Audio N" referenced in the prompt must exist.
// Returns an error string (or null). Keeps the user from shipping a prompt that
// points at a missing slot, which BytePlus would reject.
export function validatePromptReferences(prompt, tags) {
    const counts = tags.reduce((acc, t) => ({ ...acc, [t.kind]: Math.max(acc[t.kind] || 0, t.number) }), {});
    const re = /\b(Image|Video|Audio)\s+(\d+)\b/g;
    let m;
    while ((m = re.exec(prompt)) !== null) {
        const kind = m[1].toLowerCase();
        const n = Number(m[2]);
        const have = counts[kind] || 0;
        if (n > have) {
            return `Prompt references "${m[1]} ${n}" but only ${have} ${kind}${have === 1 ? '' : 's'} ${have === 1 ? 'is' : 'are'} attached.`;
        }
    }
    return null;
}
