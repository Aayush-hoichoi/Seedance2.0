// Per-output reference overrides for batch generations (×2, ×4):
// every output shares the prompt and settings; each output after the first
// may swap in its own reference — a video in video-reference modes, the
// first-frame image in image-driven modes, a reference image in Image mode.
// Variants live in mediaByRole under a synthetic role no mode ever declares,
// so flattenMedia / validate / buildTags ignore them while upload, drafts and
// Clear-all work unchanged.

export const variantRole = (k) => `batch_variant_${k}`;

// The slot a per-output variant swaps: the mode's video slot when it has one,
// else its first-frame image slot (Image → Video, First + Last frame). None
// for Text → Video (nothing to swap) and Green Screen → Mannequin (it always
// fires a single fixed-brief job regardless of batch).
export function variantSlotFor(mode) {
    if (!mode?.media?.length || mode.autoMannequin) return null;
    return mode.media.find((s) => s.kind === 'video')
        || mode.media.find((s) => s.role === 'first_frame')
        || null;
}

// The variant items to carry through rehydration / asset registration
// alongside the shared refs — each retargeted at the mode's target slot role
// and stamped with the output it belongs to (1-based; output 0 is the base).
export function collectVariantItems(mediaByRole, targetRole, batch) {
    if (!targetRole || batch < 2) return [];
    const out = [];
    for (let k = 1; k < batch; k++) {
        const item = (mediaByRole[variantRole(k)] || [])[0];
        if (item) out.push({ ...item, role: targetRole, batchVariant: k });
    }
    return out;
}

// The media list for output i: the shared refs, with output i's variant
// swapped in for the PRIMARY (first) item of its role — extra shared items of
// that role stay. When the shared refs carry none at all (Multi reference
// allows zero videos), the variant is appended instead.
export function itemsForOutput(items, i) {
    const base = items.filter((m) => !m.batchVariant);
    const v = items.find((m) => m.batchVariant === i);
    if (!v) return base;
    const { batchVariant, ...variant } = v;
    let swapped = false;
    const out = base.map((m) => {
        if (!swapped && m.role === variant.role) { swapped = true; return variant; }
        return m;
    });
    return swapped ? out : [...out, variant];
}

// Image mode (inline Gemini refs, separate from mediaByRole): output i's
// reference list — the variant replaces the FIRST reference image, or stands
// alone when none are attached.
export function imageRefsForOutput(refs, variants, i) {
    const v = variants?.[i];
    if (!v) return refs;
    return refs.length ? [v, ...refs.slice(1)] : [v];
}
