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

// Kinds whose price moves at EVERY tier, not just at 4K. kie.ai's GPT Image 2
// bills 6 / 10 / 16 credits ($0.03 / $0.05 / $0.08) for 1K / 2K / 4K, so the
// two-bucket IMAGE_RATES + IMAGE_RATES_4K shape above can't express it without
// mispricing 2K. A kind listed here is priced from this table only.
// `null` size falls to 1K deliberately: GPT Image 2 renders 1K whenever no
// explicit ratio/resolution is given, so that is the rate we would really pay.
export const IMAGE_RATES_BY_SIZE = {
    chatgpt_image_2: {
        '1K': { interactive: num(process.env.PRICE_CHATGPT_IMAGE_2_1K, 0.03) },
        '2K': { interactive: num(process.env.PRICE_CHATGPT_IMAGE_2_2K, 0.05) },
        '4K': { interactive: num(process.env.PRICE_CHATGPT_IMAGE_2_4K, 0.08) },
    },
};

// USD rate for one image through a route mode at an optional imageSize tier.
export function imageRate(kind, mode, imageSize = null) {
    const bySize = IMAGE_RATES_BY_SIZE[kind];
    if (bySize) {
        const tier = bySize[imageSize] || bySize['1K'];
        return tier[mode] ?? tier.interactive ?? null;
    }
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
