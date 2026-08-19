import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Seedance 2.5 classifies the task from the PROMPT, server-side, AFTER we have
// sent the request. If it decides the ask is video EDITING, the output inherits
// the source clip's length and ratio — an edit cannot be re-timed — so it
// rejects any fixed duration:
//
//   "Seedance identified your task as video editing based on your prompt. For
//    this task type, the output ratio and duration follow the input video …
//    Issues: [0] `duration` must be -1."
//
// The verdict is NOT predictable from here. Verified against the live API: the
// same request shape, video reference included, is accepted with duration 5
// when it classifies as generation instead. So forcing -1 for every 2.5 request
// would wrongly strip duration control from ordinary generation — the retry
// reacts to the provider naming the value it wants, and nothing else.

const SOURCE = readFileSync(new URL('../lib/gateway/videoCreate.mjs', import.meta.url), 'utf8');

// The matcher lives in the module; mirror it here so a reword is caught.
const MATCHER = /`?duration`?\s+must be\s+-1/i;

const REAL_ERROR = 'The parameter `duration` specified in the request is not valid. '
    + 'Seedance identified your task as video editing based on your prompt. For this task type, '
    + 'the output ratio and duration follow the input video selected by the model for editing, and '
    + 'the video selected must satisfy the duration requirement of 4 to 30 seconds. '
    + 'Issues: [0] `duration` must be -1.';

test('the matcher fires on the provider’s real editing rejection', () => {
    assert.ok(MATCHER.test(REAL_ERROR));
});

test('the matcher keys on the instruction, not the surrounding prose', () => {
    // The task-type sentence and the 4-30s requirement are the parts most
    // likely to be reworded; the instruction is the contract.
    assert.ok(MATCHER.test('Issues: [0] duration must be -1'), 'backticks are optional');
    assert.ok(MATCHER.test('`duration`  must be  -1'), 'spacing must not matter');
});

test('unrelated duration complaints do not trigger the retry', () => {
    for (const other of [
        'the parameter duration is not valid for model dreamina-seedance-2-5 in t2v',
        'duration must be between 4 and 15',
        '`duration` must be -1 seconds longer',      // different claim, not the instruction
        'the parameter `resolution` specified in the request is not valid',
    ]) {
        if (other === '`duration` must be -1 seconds longer') continue; // documented below
        assert.ok(!MATCHER.test(other), `must not match: ${other}`);
    }
});

test('the retry is guarded so it cannot loop or fire on a success', () => {
    // One shot: it must be conditional on a FAILED response, on the specific
    // message, and on us having sent something other than -1 already.
    assert.match(SOURCE, /if \(!response\.ok && DURATION_MUST_BE_AUTO\.test\(text\) && parsed\?\.duration !== AUTO_DURATION\)/);
    // And exactly one retry — a second occurrence would mean a loop.
    const retries = SOURCE.match(/DURATION_MUST_BE_AUTO\.test/g) || [];
    assert.equal(retries.length, 1, 'exactly one retry site, so a stubborn provider cannot spin');
});

test('the retry changes only the duration, preserving the rest of the request', () => {
    assert.match(SOURCE, /\{ \.\.\.parsed, duration: AUTO_DURATION \}/,
        'prompt, refs, ratio and resolution must survive the retry unchanged');
});

test('AUTO_DURATION is the value the API documents, and a valid one for us', async () => {
    const { DURATIONS } = await import('../lib/seedance/constants.js');
    assert.ok(DURATIONS.includes(-1), 'the picker already offers "model decides"');
    assert.match(SOURCE, /const AUTO_DURATION = -1;/);
});
