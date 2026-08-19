// Seedance 2.5 task-type locks — the pure logic behind the pinned
// ratio/duration pills and the upload-time edit-clip warning.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MODEL_25_KIND,
    EDIT_CLIP_MIN_SEC,
    EDIT_CLIP_MAX_SEC,
    seedance25Constraints,
    editClipWarning,
} from '../lib/seedance/constraints25.mjs';

test('no lock on non-2.5 models, whatever is attached', () => {
    for (const kind of ['full', 'fast', 'mini', 'pro_1_5', undefined, null]) {
        assert.equal(seedance25Constraints({ modelKind: kind, hasVideoInput: true, hasFirstFrame: true }), null);
    }
});

test('2.5 with no video and no first frame is unconstrained', () => {
    assert.equal(seedance25Constraints({ modelKind: MODEL_25_KIND }), null);
    assert.equal(seedance25Constraints({ modelKind: MODEL_25_KIND, hasVideoInput: false, hasFirstFrame: false }), null);
});

test('2.5 with a video attached pins ratio=adaptive and duration=Auto', () => {
    const lock = seedance25Constraints({ modelKind: MODEL_25_KIND, hasVideoInput: true });
    assert.equal(lock.ratio, 'adaptive');
    assert.equal(lock.duration, -1);
    assert.ok(lock.reason.length > 0);
});

test('video lock wins over first-frame when both apply', () => {
    const lock = seedance25Constraints({ modelKind: MODEL_25_KIND, hasVideoInput: true, hasFirstFrame: true });
    assert.equal(lock.duration, -1);
});

test('2.5 first-frame pins ratio only — duration stays free', () => {
    const lock = seedance25Constraints({ modelKind: MODEL_25_KIND, hasFirstFrame: true });
    assert.equal(lock.ratio, 'adaptive');
    assert.equal(lock.duration, null);
});

test('edit-clip warning fires only for out-of-window clips on 2.5', () => {
    // Shinjini's actual failure: a 3.6s clip on 2.5.
    assert.match(editClipWarning(MODEL_25_KIND, 3.6, 'clip.mp4'), /clip\.mp4 is 3\.6s/);
    assert.match(editClipWarning(MODEL_25_KIND, 31), /4–30s/);
    // In-window, boundary values, other models, and unknown durations are quiet.
    assert.equal(editClipWarning(MODEL_25_KIND, EDIT_CLIP_MIN_SEC), null);
    assert.equal(editClipWarning(MODEL_25_KIND, EDIT_CLIP_MAX_SEC), null);
    assert.equal(editClipWarning(MODEL_25_KIND, 12.4), null);
    assert.equal(editClipWarning('full', 3.6), null);
    assert.equal(editClipWarning(MODEL_25_KIND, null), null);
    assert.equal(editClipWarning(MODEL_25_KIND, undefined), null);
});
