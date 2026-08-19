import test from 'node:test';
import assert from 'node:assert/strict';
import { videoLimitsFor, validateVideoMetadata, validateAggregate, VIDEO_LIMITS } from '../lib/seedance/limits.js';

// VIDEO_LIMITS was transcribed from the Seedance 2.0 API reference and applied
// to every model. Both ends are wrong for 2.5, in opposite directions:
//
//   too loose — a 3.7s clip passed here and the provider refused it
//               (production job 7002: `content[2].video_url` invalid)
//   too tight — 16-30s clips were blocked that it would have taken
//
// 2.5's editing path states the window in its own rejection: "the video
// selected must satisfy the duration requirement of 4 to 30 seconds".

test('2.5 carries its own reference-video window', () => {
    const l = videoLimitsFor('full_2_5');
    assert.equal(l.minDurationSec, 4);
    assert.equal(l.maxDurationSec, 30);
    assert.equal(l.maxTotalDurationSec, 30);
});

test('every other model keeps the 2.0 spec', () => {
    for (const kind of ['full', 'fast', 'mini', 'pro_1_5']) {
        const l = videoLimitsFor(kind);
        assert.equal(l.minDurationSec, 2, `${kind} must not inherit 2.5's floor`);
        assert.equal(l.maxDurationSec, 15, `${kind} must not inherit 2.5's ceiling`);
    }
});

test('an unknown model falls back to the conservative spec, never 2.5’s', () => {
    assert.equal(videoLimitsFor('some-future-kind').maxDurationSec, 15);
    assert.equal(videoLimitsFor(null).minDurationSec, 2,
        'omitting the model must not silently widen the window');
});

test('the real 3.7s clip is refused on 2.5 and told why', () => {
    const err = validateVideoMetadata({ durationSec: 3.7 }, 'full_2_5');
    assert.match(err, /3\.7s/, 'the message must name the actual length');
    assert.match(err, /4–30s/, 'and the window it must fall in');
});

test('a clip 2.5 accepts is no longer blocked', () => {
    assert.equal(validateVideoMetadata({ durationSec: 20 }, 'full_2_5'), null);
    assert.equal(validateVideoMetadata({ durationSec: 30 }, 'full_2_5'), null);
    assert.match(validateVideoMetadata({ durationSec: 31 }, 'full_2_5'), /4–30s/);
});

test('the same clip is judged differently per model, which is the point', () => {
    assert.equal(validateVideoMetadata({ durationSec: 3 }, 'full'), null, '3s is fine on 2.0');
    assert.match(validateVideoMetadata({ durationSec: 3 }, 'full_2_5'), /4–30s/, 'but not on 2.5');
    assert.equal(validateVideoMetadata({ durationSec: 20 }, 'full_2_5'), null, '20s is fine on 2.5');
    assert.match(validateVideoMetadata({ durationSec: 20 }, 'full'), /2–15s/, 'but not on 2.0');
});

test('non-duration checks are unchanged by the split', () => {
    // Dimensions, aspect and fps come from the shared spec; only the duration
    // window is overridden, so a bad frame size must still fail on 2.5.
    assert.match(validateVideoMetadata({ width: 100, height: 100, durationSec: 10 }, 'full_2_5'), /each side must be/);
    assert.match(validateVideoMetadata({ durationSec: 10, fps: 12 }, 'full_2_5'), /fps/);
});

test('the combined-duration budget follows the model too', () => {
    const clips = [{ kind: 'video', durationSec: 12 }, { kind: 'video', durationSec: 12 }];
    assert.match(validateAggregate(clips, 'full'), /must not exceed 15s/, '24s busts 2.0’s budget');
    assert.equal(validateAggregate(clips, 'full_2_5'), null, 'but fits 2.5’s 30s');
});

test('the exported default stays the 2.0 spec for existing readers', () => {
    assert.equal(VIDEO_LIMITS.minDurationSec, 2);
    assert.equal(VIDEO_LIMITS.maxDurationSec, 15);
});
