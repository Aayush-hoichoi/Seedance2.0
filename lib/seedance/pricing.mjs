// Official BytePlus ModelArk online-inference token rates (USD per 1M tokens),
// keyed by stable `kind` (immune to model-id rotation). Source: ModelArk Pricing
// page, updated 2026-07-08. Update RATES here when BytePlus changes prices.
// Pure + no imports so it runs under `node --test`.

const RATES = {
    // kind: { tier: [noVideoInput, withVideoInput] }
    full: { sd: [7.0, 4.3], '1080p': [7.7, 4.7], '4k': [4.0, 2.4] },
    fast: { sd: [5.6, 3.3] },
    mini: { sd: [3.5, 2.1] },
};

// Per-video example figures (5s, 16:9, no video input) — used only for the
// creation-time cost estimate; the real cost comes from costFromTokens on finalize.
const EXAMPLE_5S = {
    full: { '480p': 0.35, '720p': 0.76, '1080p': 1.87, '4k': 3.89 },
    fast: { '480p': 0.28, '720p': 0.60 },
    mini: { '480p': 0.18, '720p': 0.38 },
};

export function resolutionTier(resolution) {
    if (resolution === '4k') return '4k';
    if (resolution === '1080p') return '1080p';
    return 'sd'; // 480p / 720p
}

export function unitPrice(kind, resolution, hasVideoInput) {
    const tiers = RATES[kind];
    if (!tiers) return null;
    const rate = tiers[resolutionTier(resolution)];
    if (!rate) return null;
    return rate[hasVideoInput ? 1 : 0];
}

export function costFromTokens(kind, resolution, hasVideoInput, completionTokens) {
    const up = unitPrice(kind, resolution, hasVideoInput);
    if (up == null || completionTokens == null) return null;
    return Number((up / 1_000_000 * completionTokens).toFixed(4));
}

// Rough pre-finalize placeholder: the 5s example scaled by duration. Video-input
// isn't factored in (it needs width/height/fps we don't have here) — the finalize
// step replaces this with the exact token-based cost anyway.
export function estimateCost({ kind, resolution, duration }) {
    const table = EXAMPLE_5S[kind];
    if (!table) return null;
    const base = table[resolution] ?? table['720p'] ?? null;
    if (base == null) return null;
    const dur = typeof duration === 'number' && duration > 0 ? duration : 5;
    return Number((base * (dur / 5)).toFixed(4));
}
