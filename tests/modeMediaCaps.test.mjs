import test from 'node:test';
import assert from 'node:assert/strict';
import { MODES, modeForModel } from '../lib/seedance/constants.js';
import { VIDEO_LIMITS, AUDIO_LIMITS, REFERENCE_IMAGE_MAX, videoLimitsFor, audioLimitsFor, referenceImageMaxFor } from '../lib/seedance/limits.js';

// A mode slot that allows more files than BytePlus accepts lets the UI build a
// request the API rejects. Caps are edited by hand, so pin them to the ceiling.
const CEILING = { video: VIDEO_LIMITS.maxCount, audio: AUDIO_LIMITS.maxCount, image: REFERENCE_IMAGE_MAX };

test('no mode slot exceeds the BytePlus per-kind ceiling', () => {
    for (const mode of MODES) {
        for (const slot of mode.media) {
            assert.ok(
                slot.max <= CEILING[slot.kind],
                `${mode.id}/${slot.role}: max ${slot.max} exceeds the ${slot.kind} ceiling of ${CEILING[slot.kind]}`,
            );
            assert.ok(slot.min <= slot.max, `${mode.id}/${slot.role}: min ${slot.min} > max ${slot.max}`);
        }
    }
});

test('motion capture takes the full video and image allowance', () => {
    const mc = MODES.find((m) => m.id === 'motion_capture');
    const bySlot = Object.fromEntries(mc.media.map((s) => [s.kind, s]));
    assert.equal(bySlot.video.max, VIDEO_LIMITS.maxCount);
    assert.equal(bySlot.image.max, REFERENCE_IMAGE_MAX);
    // Video 1 stays mandatory — the style brief treats it as the sole source of
    // performance, timing and audio truth.
    assert.equal(bySlot.video.min, 1);
});

// Seedance 2.5 raises the Multi-reference ceilings (30 images / 10 videos /
// 10 audio, doc revision 2026-08-31) — modeForModel is where the UI gets them.
test('2.5 multi-reference slots take the raised per-model ceilings', () => {
    const ref = modeForModel(MODES.find((m) => m.id === 'reference'), 'full_2_5');
    const bySlot = Object.fromEntries(ref.media.map((s) => [s.kind, s]));
    assert.equal(bySlot.image.max, referenceImageMaxFor('full_2_5'));
    assert.equal(bySlot.video.max, videoLimitsFor('full_2_5').maxCount);
    assert.equal(bySlot.audio.max, audioLimitsFor('full_2_5').maxCount);
    assert.equal(bySlot.image.max, 30);
    assert.equal(bySlot.video.max, 10);
    assert.equal(bySlot.audio.max, 10);
});

test('modeForModel leaves every other mode/model combination untouched', () => {
    for (const mode of MODES) {
        assert.equal(modeForModel(mode, 'full'), mode, `${mode.id} on 2.0 must be identity`);
        if (mode.id !== 'reference') assert.equal(modeForModel(mode, 'full_2_5'), mode, `${mode.id} on 2.5 must be identity`);
    }
    assert.equal(modeForModel(undefined, 'full_2_5'), undefined, 'missing mode passes through');
});
