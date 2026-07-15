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
