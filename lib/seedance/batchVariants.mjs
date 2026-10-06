// Per-output reference-video overrides for batch generations (×2, ×4):
// every output shares the prompt and settings; each output after the first
// may swap in its own reference video. Variants live in mediaByRole under a
// synthetic role no mode ever declares, so flattenMedia / validate /
// buildTags ignore them while upload, drafts and Clear-all work unchanged.

export const variantRole = (k) => `batch_variant_${k}`;

// The variant items to carry through rehydration / asset registration
// alongside the shared refs — each retargeted at the mode's video slot role
// and stamped with the output it belongs to (1-based; output 0 is the base).
export function collectVariantItems(mediaByRole, videoRole, batch) {
    if (!videoRole || batch < 2) return [];
    const out = [];
    for (let k = 1; k < batch; k++) {
        const item = (mediaByRole[variantRole(k)] || [])[0];
        if (item) out.push({ ...item, role: videoRole, batchVariant: k });
    }
    return out;
}

// The media list for output i: the shared refs, with output i's variant
// swapped in for the PRIMARY (first) video of its role — extra shared videos
// stay. When the shared refs carry no video at all (Multi reference allows
// zero), the variant is appended instead.
export function itemsForOutput(items, i) {
    const base = items.filter((m) => !m.batchVariant);
    const v = items.find((m) => m.batchVariant === i);
    if (!v) return base;
    const { batchVariant, ...variant } = v;
    let swapped = false;
    const out = base.map((m) => {
        if (!swapped && m.kind === 'video' && m.role === variant.role) { swapped = true; return variant; }
        return m;
    });
    return swapped ? out : [...out, variant];
}
