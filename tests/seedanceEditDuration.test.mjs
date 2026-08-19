import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hasVideoInput } from '../lib/gateway/videoCreate.mjs';
import { MODELS } from '../lib/seedance/constants.js';

// Seedance decides "this is an edit" DURING processing, not at submit. The
// create call returns 200 with a task id and the TASK fails minutes later with
// "`duration` must be -1". Verified against the live API, identical request,
// video reference and edit prompt:
//
//   duration=5   accepted at submit -> task FAILED
//   duration=-1  accepted at submit -> task SUCCEEDED
//
// Production carried three jobs (7002, 7003, 7012) that ALL had a
// provider_task_id and still failed — proof the rejection is asynchronous.
// A retry on the create response therefore could never fire; it was removed.

const SOURCE = readFileSync(new URL('../lib/gateway/videoCreate.mjs', import.meta.url), 'utf8');

test('the dead synchronous retry is gone, not left as decoration', () => {
    assert.doesNotMatch(SOURCE, /DURATION_MUST_BE_AUTO/,
        'the create response is always ok here — code that reacts to it misleads the next reader');
    assert.doesNotMatch(SOURCE, /retried with duration=-1/);
});

test('a video reference on 2.5 sends duration=-1 instead of the picked value', () => {
    assert.match(SOURCE, /const inheritsSourceDuration = MODELS\.find\(\(m\) => m\.id === modelId\)\?\.kind === 'full_2_5'/);
    assert.match(SOURCE, /&& hasVideoInput\(lowered\?\.content\)/);
    assert.match(SOURCE, /\{ \.\.\.lowered, duration: AUTO_DURATION \}/,
        'only the duration changes — prompt, refs, ratio and resolution survive');
});

test('it is scoped to 2.5, so 2.0 keeps its fixed duration with a reference video', () => {
    // 2.0 accepts a fixed duration alongside a reference video today; widening
    // this would remove duration control from a path that works.
    const kinds = [...SOURCE.matchAll(/kind === '([a-z0-9_]+)'/g)].map((m) => m[1]);
    assert.ok(kinds.includes('full_2_5'));
    assert.ok(!kinds.includes('full'), 'must not catch Seedance 2.0');
});

test('an already-auto request is left alone rather than rewritten', () => {
    assert.match(SOURCE, /lowered\?\.duration !== AUTO_DURATION/,
        'no needless rewrite, and the log line stays truthful');
});

// hasVideoInput is the trigger, so its contract matters.
test('hasVideoInput recognises both shapes the studio and MCP send', () => {
    assert.equal(hasVideoInput([{ type: 'text', text: 'hi' }, { type: 'video_url', video_url: { url: 'https://x/v.mp4' } }]), true);
    assert.equal(hasVideoInput([{ role: 'reference_video', url: 'https://x/v.mp4' }]), true);
});

test('an image-only or text-only request keeps the chosen duration', () => {
    assert.equal(hasVideoInput([{ type: 'text', text: 'a cube' }]), false);
    assert.equal(hasVideoInput([{ type: 'image_url', image_url: { url: 'https://x/i.png' } }]), false);
    assert.equal(hasVideoInput(undefined), false, 'a missing content array must not trigger it');
    assert.equal(hasVideoInput('not-an-array'), false);
});

test('AUTO_DURATION is -1 and is a tier every model accepts', async () => {
    assert.match(SOURCE, /const AUTO_DURATION = -1;/);
    const { durationValidFor } = await import('../lib/seedance/constants.js');
    for (const m of MODELS) assert.equal(durationValidFor(m.id, -1), true, `${m.name} must accept Auto`);
});
