// Image-model unit pricing (USD per image), keyed by version `kind` like
// lib/seedance/pricing.mjs does for video. Batch mode = 50% of interactive
// (Gemini Batch API). Values are best-known list prices, env-overridable so
// the owner can correct them WITHOUT a deploy; every billing event freezes
// the rate it used in pricing_snapshot, so later edits never rewrite history.

const num = (v, fallback) => (v != null && !Number.isNaN(Number(v)) ? Number(v) : fallback);

export const IMAGE_RATES = {
    seedream_pro: { interactive: num(process.env.PRICE_SEEDREAM_PRO, 0.03) },
    nano_banana_pro: {
        interactive: num(process.env.PRICE_NANO_BANANA_PRO, 0.134),
        batch: num(process.env.PRICE_NANO_BANANA_PRO_BATCH, 0.067),
    },
    nano_banana_2: {
        interactive: num(process.env.PRICE_NANO_BANANA_2, 0.039),
        batch: num(process.env.PRICE_NANO_BANANA_2_BATCH, 0.0195),
    },
};

// USD for `count` images through a route mode ('interactive' | 'batch').
export function imageCost(kind, mode, count = 1) {
    const rates = IMAGE_RATES[kind];
    if (!rates || !count) return null;
    const rate = rates[mode] ?? rates.interactive;
    return rate == null ? null : Number((rate * count).toFixed(4));
}
