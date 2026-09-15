// The money line in the prompt bar: what one generation is expected to cost at
// the current pill selection, and how to say it. Split out of PromptBar.jsx so
// it runs under `node --test` without a renderer (same split as
// app/console/spendSeries.mjs).

import { clampImageResolution } from '../../lib/seedance/constants.js';
import { estimateCost } from '../../lib/seedance/pricing.mjs';
import { imageCost } from '../../lib/gateway/imagePricing.mjs';

// Price of ONE generation at the current selection. This deliberately mirrors
// estimateFor() in lib/gateway/enqueue.mjs — same functions, same inputs — so
// the number the user reads is the number the gateway reserves against their
// budget. Every parameter that moves the price is read here:
//
//   video   model (kind), resolution, duration, attached video reference
//   image   model (kind), resolution, aspect ratio (via the clamp), quality
//
// Parameters absent from this list are priced by NEITHER side: seed, watermark,
// audio, output container, task type and the 2.5 engine variant carry no rate
// dimension in either table, so they must not move the quote either.
export function unitEstimate({ isImage, model, imageModel, options = {}, hasVideoInput = false }) {
    if (isImage) {
        if (!imageModel) return null;
        return imageCost(
            imageModel.kind,
            'interactive',
            1, // the studio submits imageCount: 1; ×N comes from the batch pills
            // The tier the SUBMIT boundary will actually bill. enqueue.mjs runs
            // this same clamp before reserving, so a ratio that caps the tier
            // (GPT Image 2 renders 1K at 5:4 however high the pill is set) has
            // to move the price here too.
            clampImageResolution(
                options.model,
                options.imageRatio || null,
                imageModel.resolutions ? options.imageResolution || null : null,
            ),
            imageModel.qualities ? options.imageQuality || null : null,
        );
    }
    return estimateCost({
        kind: model?.kind,
        resolution: options.resolution,
        duration: options.duration,
        hasVideoInput,
    });
}

// How far the shown estimate can miss the settled charge, per generation.
// Video is the reason this exists: estimateCost() scales a hardcoded 5s example
// by duration, while the real charge comes from the provider's token count at
// settlement (lib/gateway/processor.mjs). A band makes the number read as a
// forecast rather than a quote. Note images settle at EXACTLY the rate shown —
// imageCost() is the same function both sides — so for those the band is
// conservative, not measured.
export const ESTIMATE_ERROR_USD = 0.15;

// unitUsd  — per-generation estimate in USD, or null when the model has no
//            known price.
// batch    — how many generations one click fires; cost and error both scale.
// hasContent — whether the bar holds a prompt or a reference. An empty bar
//            generates nothing, so it costs nothing: $0.00, no band.
// Returns { text, title }, or null when there is no honest number to show.
export function estimateLabel({ unitUsd, batch = 1, hasContent = true }) {
    if (!hasContent) {
        return { text: '≈ $0.00', title: 'Add a prompt or a reference to price this generation.' };
    }
    if (unitUsd == null) return null;
    const n = batch > 0 ? batch : 1;
    const error = (ESTIMATE_ERROR_USD * n).toFixed(2);
    return {
        text: `≈ $${(unitUsd * n).toFixed(2)} ± $${error}`,
        title: `Estimated cost. The final charge uses real usage, so it can land about $${error} either side of this.`,
    };
}
