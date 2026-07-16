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

// 4K outputs cost more on Gemini 3 Pro Image (2000 output tokens vs 1120):
// $0.24 interactive / $0.12 batch, vs $0.134 / $0.067 at 1K/2K. Kinds absent
// here (Seedream, Nano Banana 2) fall back to IMAGE_RATES — their list price
// is flat per image regardless of size.
export const IMAGE_RATES_4K = {
    nano_banana_pro: {
        interactive: num(process.env.PRICE_NANO_BANANA_PRO_4K, 0.24),
        batch: num(process.env.PRICE_NANO_BANANA_PRO_4K_BATCH, 0.12),
    },
};

// USD rate for one image through a route mode at an optional imageSize tier.
export function imageRate(kind, mode, imageSize = null) {
    const rates = (imageSize === '4K' && IMAGE_RATES_4K[kind]) || IMAGE_RATES[kind];
    if (!rates) return null;
    return rates[mode] ?? rates.interactive ?? null;
}

// USD for `count` images through a route mode ('interactive' | 'batch').
export function imageCost(kind, mode, count = 1, imageSize = null) {
    const rate = imageRate(kind, mode, imageSize);
    if (rate == null || !count) return null;
    return Number((rate * count).toFixed(4));
}
