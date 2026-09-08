// Seedance 2.5 doc-alignment (revisions 2026-08-31 / 2026-09-04):
// omni_reference_task_type + output_format plumbing, the raised audio/image
// reference allowances, and the gateway's task-type-aware duration force.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPayload } from '../lib/seedance/client.js';
import { ratioIsInherited, MODELS } from '../lib/seedance/constants.js';
import {
    audioLimitsFor, referenceImageMaxFor, validateAudioMetadata, validateAggregate,
} from '../lib/seedance/limits.js';

const MODEL_25_ID = MODELS.find((m) => m.kind === 'full_2_5').id;

// ── reference allowances ─────────────────────────────────────────────────────

test('2.5 carries its own audio window; everyone else keeps the 2.0 spec', () => {
    const l25 = audioLimitsFor('full_2_5');
    assert.equal(l25.maxCount, 10);
    assert.equal(l25.maxDurationSec, 30);
    assert.equal(l25.maxTotalDurationSec, 30);
    for (const kind of ['full', 'fast', 'mini', 'pro_1_5', 'some-future-kind', null]) {
        const l = audioLimitsFor(kind);
        assert.equal(l.maxCount, 3, `${kind} must not inherit 2.5's count`);
        assert.equal(l.maxTotalDurationSec, 15, `${kind} must not inherit 2.5's budget`);
    }
});

test('a 20s audio clip passes on 2.5 and is refused elsewhere', () => {
    assert.equal(validateAudioMetadata({ durationSec: 20 }, 'full_2_5'), null);
    assert.match(validateAudioMetadata({ durationSec: 20 }, 'full'), /2–15s/);
    assert.match(validateAudioMetadata({ durationSec: 20 }), /2–15s/, 'omitted model keeps the conservative spec');
});

test('reference-image ceiling is 30 on 2.5, 9 everywhere else', () => {
    assert.equal(referenceImageMaxFor('full_2_5'), 30);
    assert.equal(referenceImageMaxFor('full'), 9);
    assert.equal(referenceImageMaxFor(null), 9);
});

test('aggregate check enforces the per-model audio and image counts', () => {
    const audios = (n) => Array.from({ length: n }, () => ({ kind: 'audio', durationSec: 2 }));
    assert.equal(validateAggregate(audios(10), 'full_2_5'), null);
    assert.match(validateAggregate(audios(11), 'full_2_5'), /Too many reference audio/);
    assert.match(validateAggregate(audios(4), 'full'), /Too many reference audio/);
    const images = (n) => Array.from({ length: n }, () => ({ kind: 'image' }));
    assert.equal(validateAggregate(images(30), 'full_2_5'), null);
    assert.match(validateAggregate(images(31), 'full_2_5'), /Too many reference images/);
    assert.match(validateAggregate(images(10), 'full'), /Too many reference images/);
});

// ── payload plumbing ─────────────────────────────────────────────────────────

const baseOptions = { model: MODEL_25_ID, ratio: 'adaptive', resolution: '720p', generate_audio: true, watermark: false, duration: -1 };

test('buildPayload forwards omni_reference_task_type and a non-default output_format', () => {
    const p = buildPayload({
        options: { ...baseOptions, omni_reference_task_type: 'reference', output_format: 'mov' },
        prompt: 'x', mediaItems: [],
    });
    assert.equal(p.omni_reference_task_type, 'reference');
    assert.equal(p.output_format, 'mov');
});

test('buildPayload omits both fields when unset, mp4 or null — the 2.0 payload is unchanged', () => {
    for (const extra of [{}, { output_format: 'mp4' }, { output_format: null, omni_reference_task_type: null }]) {
        const p = buildPayload({ options: { ...baseOptions, ...extra }, prompt: 'x', mediaItems: [] });
        assert.ok(!('omni_reference_task_type' in p), JSON.stringify(extra));
        assert.ok(!('output_format' in p), JSON.stringify(extra));
    }
});

// ── ratio inheritance honors the declared subtype ────────────────────────────

test('a declared reference task keeps the ratio choice; edit/extend/auto do not', () => {
    const args = { modelId: MODEL_25_ID, hasVideoRef: true };
    assert.equal(ratioIsInherited({ ...args, taskType: 'reference' }), false);
    for (const taskType of ['auto', 'edit', 'extend', undefined]) {
        assert.equal(ratioIsInherited({ ...args, taskType }), true, `taskType=${taskType}`);
    }
});

test('first-frame inherits the ratio whatever the declared subtype', () => {
    assert.equal(ratioIsInherited({ modelId: MODEL_25_ID, hasFirstFrame: true, taskType: 'reference' }), true);
});

// ── gateway force is task-type aware (source pin, same style as
//    seedanceEditDuration.test.mjs — the logic is inline in createVideoTask) ──

const SOURCE = readFileSync(new URL('../lib/gateway/videoCreate.mjs', import.meta.url), 'utf8');

test('the duration force skips declared reference and extend tasks', () => {
    assert.match(SOURCE, /taskType === 'auto' \|\| taskType === 'edit'/,
        'only edit and undecided auto may rewrite duration');
    assert.match(SOURCE, /OMNI_TASK_TYPES\.includes\(taskType\)/,
        'an invalid declared type is rejected before a slot is taken');
});
