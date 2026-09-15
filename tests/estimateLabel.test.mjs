// The prompt bar quotes a price before the user spends anything, so the quote
// has to track the SELECTION — every pill that moves the real charge, and no
// pill that doesn't. It also has to agree with lib/gateway/enqueue.mjs, which
// reserves budget from the same rate tables; a bar that quotes one tier while
// the gateway bills another is a number the user cannot act on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateLabel, unitEstimate, ESTIMATE_ERROR_USD } from '../app/seedance/estimateLabel.mjs';
import { MODELS, IMAGE_MODELS, IMAGE_RATIOS, supportedResolutionsFor } from '../lib/seedance/constants.js';

const imageModel = (id) => IMAGE_MODELS.find((m) => m.id === id);
const videoModel = (kind) => MODELS.find((m) => m.kind === kind);

const imageQuote = (id, options) =>
    unitEstimate({ isImage: true, imageModel: imageModel(id), options: { model: id, ...options } });
const videoQuote = (kind, options, hasVideoInput = false) =>
    unitEstimate({ isImage: false, model: videoModel(kind), options, hasVideoInput });

/* ── the label ──────────────────────────────────────────────────────────── */

test('an empty bar costs nothing, with no error band', () => {
    // The bug: the bar quoted the selected model's price (≈ $0.38) with no
    // prompt and no reference attached — a charge the user was not about to
    // incur. Priced models must still read $0.00 while the bar is empty.
    assert.equal(estimateLabel({ unitUsd: 0.38, hasContent: false }).text, '≈ $0.00');
    assert.equal(estimateLabel({ unitUsd: null, hasContent: false }).text, '≈ $0.00');
    assert.equal(estimateLabel({ unitUsd: 0.38, batch: 2, hasContent: false }).text, '≈ $0.00');
});

test('a filled bar shows the model price ± the error band', () => {
    assert.equal(estimateLabel({ unitUsd: 0.38 }).text, '≈ $0.38 ± $0.15');
    assert.equal(estimateLabel({ unitUsd: 0.03 }).text, '≈ $0.03 ± $0.15');
});

test('batch scales the estimate and the band together', () => {
    assert.equal(estimateLabel({ unitUsd: 0.38, batch: 2 }).text, '≈ $0.76 ± $0.30');
    // A bad/zero batch must not zero the price or divide by nothing.
    assert.equal(estimateLabel({ unitUsd: 0.38, batch: 0 }).text, '≈ $0.38 ± $0.15');
});

test('an unpriced model on a filled bar shows nothing rather than a fake $0.00', () => {
    // $0.00 here would claim the generation is free; it just is not priced.
    assert.equal(estimateLabel({ unitUsd: null }), null);
});

test('the band is a stated constant, not a magic number in the view', () => {
    assert.equal(ESTIMATE_ERROR_USD, 0.15);
});

/* ── the quote tracks the video selection ───────────────────────────────── */

test('every video model is priced at every tier and duration it offers', () => {
    for (const model of MODELS) {
        for (const resolution of supportedResolutionsFor(model.id) ?? []) {
            for (const duration of [5, 10, model.maxDuration ?? 15]) {
                const usd = videoQuote(model.kind, { resolution, duration });
                assert.ok(typeof usd === 'number' && usd > 0,
                    `${model.name} has no quote at ${resolution}/${duration}s — the bar would show nothing`);
            }
        }
    }
});

test('the video quote moves with resolution, duration and an attached video', () => {
    const at = (o, hasVideo) => videoQuote('mini', { resolution: '720p', duration: 5, ...o }, hasVideo);
    assert.equal(at({}), 0.38);
    assert.equal(at({ resolution: '480p' }), 0.18, 'a cheaper tier must quote cheaper');
    assert.equal(at({ duration: 10 }), 0.76, 'twice the seconds is twice the price');
    assert.ok(at({}, true) > at({}), 'video-input tasks settle higher, so they must quote higher');
});

test('an adaptive duration quotes the longest the model could return', () => {
    // Pricing "Auto" as 5s is how spend crossed hard caps (see pricing.mjs).
    // The bar must show the number the gateway actually reserves.
    assert.equal(videoQuote('full', { resolution: '1080p', duration: -1 }),
        videoQuote('full', { resolution: '1080p', duration: 15 }));
    assert.equal(videoQuote('full_2_5', { resolution: '1080p', duration: -1 }),
        videoQuote('full_2_5', { resolution: '1080p', duration: 30 }), '2.5 runs to 30s');
});

test('video pills with no rate dimension leave the quote alone', () => {
    const base = videoQuote('mini', { resolution: '720p', duration: 5 });
    for (const noise of [{ seed: 42 }, { watermark: true }, { generate_audio: true },
        { output_format: 'mov' }, { taskType: 'edit' }, { ratio: '9:16' }]) {
        assert.equal(videoQuote('mini', { resolution: '720p', duration: 5, ...noise }), base,
            `${Object.keys(noise)[0]} carries no rate in either table — it must not move the quote`);
    }
});

/* ── the quote tracks the image selection ───────────────────────────────── */

test('every image model is priced at every ratio × tier it offers', () => {
    for (const model of IMAGE_MODELS) {
        for (const imageRatio of IMAGE_RATIOS) {
            for (const imageResolution of model.resolutions ?? [null]) {
                const usd = imageQuote(model.id, { imageRatio, imageResolution });
                assert.ok(typeof usd === 'number' && usd > 0,
                    `${model.name} has no quote at ${imageRatio}/${imageResolution} — the bar would show nothing`);
            }
        }
    }
});

test('the image quote moves with the resolution tier where the provider charges per tier', () => {
    assert.equal(imageQuote('chatgpt-image-2', { imageRatio: '16:9', imageResolution: '1K' }), 0.03);
    assert.equal(imageQuote('chatgpt-image-2', { imageRatio: '16:9', imageResolution: '2K' }), 0.05);
    assert.equal(imageQuote('chatgpt-image-2', { imageRatio: '16:9', imageResolution: '4K' }), 0.08);
    // Nano Banana Pro is flat to 2K and steps up only at 4K.
    assert.equal(imageQuote('nano-banana-pro', { imageResolution: '2K' }), 0.134);
    assert.equal(imageQuote('nano-banana-pro', { imageResolution: '4K' }), 0.24);
    // Seedream is flat per image whatever the tier.
    assert.equal(imageQuote('seedream-5.0-pro', { imageResolution: '2K' }), 0.03);
    assert.equal(imageQuote('seedream-5.0-pro', { imageResolution: '4K' }), 0.03);
});

test('a ratio that caps the tier is quoted at the tier actually rendered', () => {
    // The gap this closes: kie's GPT Image 2 renders 1K at 5:4 and 4:5 no matter
    // how high the resolution pill is set, and enqueue.mjs clamps the request
    // before reserving — so the bar was quoting $0.08 for a $0.03 render.
    for (const imageRatio of ['5:4', '4:5']) {
        for (const imageResolution of ['1K', '2K', '4K']) {
            assert.equal(imageQuote('chatgpt-image-2', { imageRatio, imageResolution }), 0.03,
                `${imageRatio} renders 1K, so it must quote the 1K price`);
        }
    }
    // The coupling is one provider's quirk; it must not leak onto the others.
    assert.equal(imageQuote('nano-banana-pro', { imageRatio: '5:4', imageResolution: '4K' }), 0.24);
    assert.equal(imageQuote('chatgpt-image-2.5', { imageRatio: '5:4', imageResolution: '4K' }), 0.32);
});

test('quality moves the quote on the model that sells it, and only there', () => {
    const at = (quality) => imageQuote('chatgpt-image-2.5', { imageRatio: '1:1', imageResolution: '1K', imageQuality: quality });
    assert.equal(at('medium'), 0.05);
    assert.equal(at(null), at('medium'), 'no pick means medium, the base rate');
    assert.equal(at('low'), 0.015);
    assert.equal(at('high'), 0.2);
    // Every other model has no quality pill, so the option must be ignored
    // rather than silently scaling a rate it was never meant to touch.
    assert.equal(imageQuote('nano-banana-2', { imageResolution: '2K', imageQuality: 'high' }),
        imageQuote('nano-banana-2', { imageResolution: '2K' }));
});

test('Cinematic Studio is priced as the Pro model it runs on', () => {
    // It is its own catalog entry and its own grant, but the same provider
    // route — so it must never quote blank while charging Pro rates.
    assert.equal(imageQuote('cinematic-studio', { imageResolution: '4K' }),
        imageQuote('nano-banana-pro', { imageResolution: '4K' }));
});

test('image pills with no rate dimension leave the quote alone', () => {
    const base = imageQuote('chatgpt-image-2.5', { imageRatio: '1:1', imageResolution: '2K' });
    for (const variant of ['flare', 'sunburst']) {
        assert.equal(imageQuote('chatgpt-image-2.5', { imageRatio: '1:1', imageResolution: '2K', imageVariant: variant }),
            base, 'neither rate table has an engine dimension');
    }
});

test('an unknown image model quotes nothing rather than guessing', () => {
    assert.equal(unitEstimate({ isImage: true, imageModel: undefined, options: {} }), null);
    assert.equal(unitEstimate({ isImage: false, model: undefined, options: { resolution: '720p', duration: 5 } }), null);
});
