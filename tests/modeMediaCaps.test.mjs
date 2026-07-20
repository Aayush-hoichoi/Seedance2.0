import test from 'node:test';
import assert from 'node:assert/strict';
import { MODES } from '../lib/seedance/constants.js';
import { VIDEO_LIMITS, AUDIO_LIMITS, REFERENCE_IMAGE_MAX } from '../lib/seedance/limits.js';

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
