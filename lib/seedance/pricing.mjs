// Official BytePlus ModelArk online-inference token rates (USD per 1M tokens),
// keyed by stable `kind` (immune to model-id rotation). Source: ModelArk Pricing
// page (https://docs.byteplus.com/en/docs/ModelArk/1544106), updated 2026-07-08.
// Update RATES here when BytePlus changes prices.
// Pure + no imports so it runs under `node --test`.

const RATES = {
    // kind: { tier: [noVideoInput, withVideoInput] }
    full: { sd: [7.0, 4.3], '1080p': [7.7, 4.7], '4k': [4.0, 2.4] },
    fast: { sd: [5.6, 3.3] },
    mini: { sd: [3.5, 2.1] },
    // Seedance 1.5 Pro: derived from OpenRouter's cited $0.02306/second and the
    // ModelArk token formula tokens=(W*H*dur*24)/1024. At 720p (21,600 tok/s)
    // that's $0.02306/21600*1e6 ≈ $1.07 per 1M tokens. Flat across tiers (only a
    // single per-second figure is published) and no 4k (1.5 tops out at 1080p).
    // 1.5 is T2V/I2V (no video input), so both columns are equal.
    pro_1_5: { sd: [1.07, 1.07], '1080p': [1.07, 1.07] },
};

// Per-video example figures (5s, 16:9, no video input) — used only for the
// creation-time cost estimate; the real cost comes from costFromTokens on finalize.
const EXAMPLE_5S = {
    full: { '480p': 0.35, '720p': 0.76, '1080p': 1.87, '4k': 3.89 },
    fast: { '480p': 0.28, '720p': 0.60 },
    mini: { '480p': 0.18, '720p': 0.38 },
    pro_1_5: { '480p': 0.05, '720p': 0.12, '1080p': 0.26 }, // $1.07/1M × token formula (see RATES)
};

// Raw client/MCP input reaches these lookups — tolerate casing ('4K', '1080P')
// so a variant never silently drops to the wrong price tier.
const norm = (r) => (typeof r === 'string' ? r.toLowerCase() : r);

export function resolutionTier(resolution) {
    const r = norm(resolution);
    if (r === '4k') return '4k';
    if (r === '1080p') return '1080p';
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

// Measured drift: settled costs ran ~17% above these estimates on video-input
// tasks. The per-token rate is LOWER with video input, but such tasks emit
// enough extra tokens that the net cost is higher — so scaling by the
// unitPrice ratio would move the estimate the wrong way. Empirical multiplier
// until we can estimate token counts directly.
const VIDEO_INPUT_DRIFT = 1.17;

// Rough pre-finalize placeholder: the 5s example scaled by duration, nudged up
// for video input (see VIDEO_INPUT_DRIFT) — the finalize step replaces this
// with the exact token-based cost anyway.
export function estimateCost({ kind, resolution, duration, hasVideoInput = false }) {
    const table = EXAMPLE_5S[kind];
    if (!table) return null;
    const base = table[norm(resolution)] ?? table['720p'] ?? null;
    if (base == null) return null;
    const dur = typeof duration === 'number' && duration > 0 ? duration : 5;
    return Number((base * (dur / 5) * (hasVideoInput ? VIDEO_INPUT_DRIFT : 1)).toFixed(4));
}
