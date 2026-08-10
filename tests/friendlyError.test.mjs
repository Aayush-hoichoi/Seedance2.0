import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyError } from '../lib/seedance/friendlyError.js';

test('maps unsupported task_type (r2v on 1.5 Pro) to a model-switch hint', () => {
    const raw = 'The parameter `task_type` specified in the request is not valid: the specified task_type r2v does not support model seedance-1-5-pro. Request id: 0217841112849720eb';
    const out = friendlyError(raw);
    assert.match(out, /doesn.t support reference/i);
    assert.doesNotMatch(out, /task_type|Request id/);
});

test('maps CreateAsset rate limiting to a wait-and-retry hint', () => {
    const out = friendlyError('Source video verification failed — Create asset rate limit exceeded, please retry later.');
    assert.match(out, /wait|minute/i);
    assert.doesNotMatch(out, /Create asset rate limit/);
});

test('maps a full asset pool to the cleanup hint', () => {
    assert.match(friendlyError('Asset quota exceeded: the shared pool is full.'), /retry in a moment/i);
    assert.match(friendlyError('The BytePlus asset pool is still full after clearing studio assets — delete unused assets…'), /retry in a moment/i);
});

test('maps sensitive-content flags to actionable copy', () => {
    const out = friendlyError('InputVideoSensitiveContentDetected: input video may contain sensitive information');
    assert.match(out, /flagged|sensitive/i);
    assert.doesNotMatch(out, /InputVideoSensitiveContentDetected/);
});

test('passes through unknown messages, stripping the provider request id', () => {
    assert.equal(
        friendlyError('Something odd happened. Request id: 02178abc'),
        'Something odd happened.',
    );
    assert.equal(friendlyError('No open video slot left for clip.mp4.'), 'No open video slot left for clip.mp4.');
});

test('empty input stays empty', () => {
    assert.equal(friendlyError(null), null);
    assert.equal(friendlyError(''), '');
});

// One bare /quota/i used to claim that FOUR unrelated failures were all a full
// reference-asset pool. On 2026-08-10 the studio showed "the reference-asset
// pool filled up — delete unused assets" while the pool held four objects, none
// older than an hour. Worst case, a user who had merely exhausted their BUDGET
// was sent to delete assets in a third party's console.
const QUOTA_CASES = [
    {
        name: 'the provider’s own billing quota (real Gemini text, job 5128)',
        raw: 'You exceeded your current quota, please check your plan and billing details. '
            + 'For more information on this error, head to: https://ai.google.dev/gemini-api/docs/',
        expect: /billing quota/i,
    },
    {
        name: 'BytePlus per-minute write throttle',
        raw: 'QuotaWriteQPMExceeded: request rejected',
        expect: /rate-limiting/i,
    },
    {
        name: 'this workspace’s own spend cap',
        raw: 'A budget or quota limit would be exceeded.',
        expect: /budget for your project/i,
    },
    {
        name: 'genuine pool exhaustion',
        raw: 'The BytePlus asset pool is still full after clearing studio assets — '
            + 'delete unused assets in the BytePlus console (Asset Library) and try again.',
        expect: /reference-asset pool filled up/i,
    },
];

for (const { name, raw, expect } of QUOTA_CASES) {
    test(`quota-shaped error is attributed to its real cause: ${name}`, () => {
        assert.match(friendlyError(raw), expect);
    });
}

test('the four quota-shaped errors do not collapse onto one message', () => {
    const messages = QUOTA_CASES.map(({ raw }) => friendlyError(raw));
    assert.equal(new Set(messages).size, QUOTA_CASES.length,
        `distinct causes must read differently, got:\n${messages.join('\n')}`);
});

test('only genuine capacity exhaustion mentions deleting assets', () => {
    for (const { raw, name } of QUOTA_CASES) {
        const msg = friendlyError(raw);
        const isPool = /asset pool is still full/i.test(raw);
        assert.equal(/delete unused assets/i.test(msg), isPool,
            `${name}: advice to delete assets must appear only for a full pool`);
    }
});
