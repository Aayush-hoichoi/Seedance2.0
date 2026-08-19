import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ratioIsInherited, INHERITED_RATIO, MODELS } from '../lib/seedance/constants.js';

// Per the Seedance 2.5 docs, ratio "defaults to and only supports adaptive" for
// video editing, video extension, and first/last-frame generation — the output
// follows the selected input. Sending 16:9 fails the task: it was one of the
// three parameters production job 7002 was rejected on.
//
// So the picker is hidden for those tasks. A control whose value is discarded
// is worse than no control: it tells the user they chose something.

const id = (kind) => MODELS.find((m) => m.kind === kind).id;

test('a video reference on 2.5 makes the ratio inherited', () => {
    assert.equal(ratioIsInherited({ modelId: id('full_2_5'), hasVideoRef: true }), true,
        'the model may classify this as an edit while it renders — the ratio is not ours either way');
});

test('a first or last frame makes the ratio inherited', () => {
    assert.equal(ratioIsInherited({ modelId: id('full_2_5'), hasFirstFrame: true }), true);
});

test('text-only and image-only 2.5 requests keep the picker', () => {
    assert.equal(ratioIsInherited({ modelId: id('full_2_5') }), false);
    assert.equal(ratioIsInherited({ modelId: id('full_2_5'), hasVideoRef: false, hasFirstFrame: false }), false,
        'reference-to-video from images has no source ratio to inherit');
});

test('2.0 is untouched — its own reference does not state the restriction', () => {
    for (const kind of ['full', 'fast', 'mini', 'pro_1_5']) {
        assert.equal(ratioIsInherited({ modelId: id(kind), hasVideoRef: true }), false,
            `${kind} accepts a fixed ratio today; widening this on assumption is the mistake we keep making`);
    }
});

test('an unknown model never inherits', () => {
    assert.equal(ratioIsInherited({ modelId: 'some-future-model', hasVideoRef: true }), false);
});

test('the inherited value is the one the API documents', () => {
    assert.equal(INHERITED_RATIO, 'adaptive');
});

// --- the two consumers ---------------------------------------------------------

test('the server sends adaptive rather than the picked ratio', () => {
    const src = readFileSync(new URL('../lib/gateway/videoCreate.mjs', import.meta.url), 'utf8');
    assert.match(src, /ratioIsInherited\(\{ modelId, hasVideoRef: withVideoRef, hasFirstFrame \}\)/);
    assert.match(src, /ratio: INHERITED_RATIO/);
    assert.match(src, /lowered\?\.ratio !== INHERITED_RATIO/,
        'an already-adaptive request must not be needlessly rewritten');
});

test('the picker is hidden, not merely disabled, when the ratio is inherited', () => {
    const src = readFileSync(new URL('../app/seedance/PromptBar.jsx', import.meta.url), 'utf8');
    assert.match(src, /\{!ratioInherited && \(/, 'the Aspect Ratio pill is conditionally rendered');
    assert.match(src, /const ratioInherited = !isImage && ratioIsInherited\(\{/,
        'image mode has its own ratio control and must be unaffected');
});

test('duration and ratio are forced together, from one decision', () => {
    const src = readFileSync(new URL('../lib/gateway/videoCreate.mjs', import.meta.url), 'utf8');
    assert.match(src, /inheritsSourceDuration \|\| inheritsSourceRatio/,
        'one payload rewrite, so the two cannot disagree about what the source governs');
});
