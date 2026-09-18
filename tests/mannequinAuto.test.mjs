import test from 'node:test';
import assert from 'node:assert/strict';
import { MODES, MANNEQUIN_SOURCE_PROMPT } from '../lib/seedance/constants.js';

// Green Screen → Mannequin is a single conversion: SeedanceStudio keys the
// flow off these flags and the fixed brief, so their shape is the contract
// worth guarding.

const mode = MODES.find((m) => m.id === 'mannequin_auto');

test('mannequin_auto mode carries the conversion contract', () => {
    assert.ok(mode, 'mannequin_auto mode exists');
    assert.equal(mode.autoMannequin, true); // triggers the fixed-brief generation
    assert.equal(mode.silentSource, true); // audio-on guard must not apply
    assert.equal(mode.requiresText, false); // the fixed brief IS the prompt
    assert.equal(mode.enhanceStyle, undefined); // no enhancer round-trip
    // Exactly one green-screen video in, nothing else.
    assert.equal(mode.media.length, 1);
    const video = mode.media[0];
    assert.deepEqual({ kind: video.kind, min: video.min, max: video.max, role: video.role }, { kind: 'video', min: 1, max: 1, role: 'reference_video' });
});

test('conversion brief locks the mannequin invariants', () => {
    // Silent output — the mannequin is a motion source, no dialogue.
    assert.match(MANNEQUIN_SOURCE_PROMPT, /SILENT output/i);
    // Motion must transfer untouched, identity must not survive.
    assert.match(MANNEQUIN_SOURCE_PROMPT, /Do not add, remove, smooth/i);
    assert.match(MANNEQUIN_SOURCE_PROMPT, /No trace of the original performer/i);
    // Exact-motion lock: frame-by-frame full-body copy, 1:1 timing, same
    // in-frame position — the invariants that stop the model improvising.
    assert.match(MANNEQUIN_SOURCE_PROMPT, /frame by frame/i);
    assert.match(MANNEQUIN_SOURCE_PROMPT, /FULL-BODY/i);
    assert.match(MANNEQUIN_SOURCE_PROMPT, /1:1/);
    assert.match(MANNEQUIN_SOURCE_PROMPT, /SAME position, scale and path/i);
    assert.match(MANNEQUIN_SOURCE_PROMPT, /perfectly still/i);
    // Green screen is replaced with pitch black, camera is reproduced.
    assert.match(MANNEQUIN_SOURCE_PROMPT, /Replace the green screen/i);
    assert.match(MANNEQUIN_SOURCE_PROMPT, /PITCH-BLACK/i);
    assert.match(MANNEQUIN_SOURCE_PROMPT, /evenly lit/i); // white body must stay visible on black
    assert.doesNotMatch(MANNEQUIN_SOURCE_PROMPT, /light-grey/i);
    assert.match(MANNEQUIN_SOURCE_PROMPT, /camera exactly/i);
});
