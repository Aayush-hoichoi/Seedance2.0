import test from 'node:test';
import assert from 'node:assert/strict';
import { MODES, MANNEQUIN_SOURCE_PROMPT } from '../lib/seedance/constants.js';

// Green Screen → Mannequin is a two-stage chain: SeedanceStudio keys the whole
// flow off these flags and the fixed stage-1 brief, so their shape is the
// contract worth guarding.

const mode = MODES.find((m) => m.id === 'mannequin_auto');

test('mannequin_auto mode carries the chain contract', () => {
    assert.ok(mode, 'mannequin_auto mode exists');
    assert.equal(mode.autoMannequin, true); // triggers the two-stage fork
    assert.equal(mode.silentSource, true); // audio-on guard must not apply
    assert.equal(mode.enhanceStyle, 'mannequin'); // stage-2 prompt uses the mannequin brief
    // Stage 1 needs exactly one video; stage 2 needs at least one identity image.
    const video = mode.media.find((s) => s.kind === 'video');
    const image = mode.media.find((s) => s.kind === 'image');
    assert.deepEqual({ min: video.min, max: video.max, role: video.role }, { min: 1, max: 1, role: 'reference_video' });
    assert.equal(image.min, 1);
});

test('stage-1 brief locks the mannequin conversion invariants', () => {
    // Silent output — stage 2 depends on there being no dialogue to carry over.
    assert.match(MANNEQUIN_SOURCE_PROMPT, /SILENT output/i);
    // Motion must transfer untouched, identity must not survive.
    assert.match(MANNEQUIN_SOURCE_PROMPT, /Do not add, remove, smooth/i);
    assert.match(MANNEQUIN_SOURCE_PROMPT, /No trace of the original performer/i);
    // Green screen is replaced with pitch black, camera is reproduced.
    assert.match(MANNEQUIN_SOURCE_PROMPT, /Replace the green screen/i);
    assert.match(MANNEQUIN_SOURCE_PROMPT, /PITCH-BLACK/i);
    assert.match(MANNEQUIN_SOURCE_PROMPT, /evenly lit/i); // white body must stay visible on black
    assert.doesNotMatch(MANNEQUIN_SOURCE_PROMPT, /light-grey/i);
    assert.match(MANNEQUIN_SOURCE_PROMPT, /camera exactly/i);
});
