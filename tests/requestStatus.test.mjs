import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStatus, reRequestDecision } from '../lib/access/requestStatus.mjs';

test('maps each action to its status', () => {
    assert.equal(nextStatus('request'), 'pending');
    assert.equal(nextStatus('approve'), 'approved');
    assert.equal(nextStatus('revoke'), 'revoked');
});

test('throws on an unknown action', () => {
    assert.throws(() => nextStatus('delete'), /Unknown action/);
});

const NOW = new Date('2026-07-17T12:00:00Z');

test('reRequestDecision: no existing row → fresh request', () => {
    assert.equal(reRequestDecision(null, NOW), 'fresh');
    assert.equal(reRequestDecision(undefined, NOW), 'fresh');
});

test('reRequestDecision: a live pending request is a duplicate, not a fresh one', () => {
    assert.equal(reRequestDecision({ status: 'pending' }, NOW), 'pending');
});

test('reRequestDecision: a live grant is never touched (with or without expiry)', () => {
    assert.equal(reRequestDecision({ status: 'approved', expires_at: null }, NOW), 'approved');
    assert.equal(reRequestDecision({ status: 'approved', expires_at: '2026-07-18T00:00:00Z' }, NOW), 'approved');
});

test('reRequestDecision: an expired grant re-opens as a fresh request', () => {
    assert.equal(reRequestDecision({ status: 'approved', expires_at: '2026-07-16T23:59:59Z' }, NOW), 'fresh');
    assert.equal(reRequestDecision({ status: 'approved', expires_at: NOW.toISOString() }, NOW), 'fresh'); // boundary: expiry == now
});

test('reRequestDecision: a revoked/denied request may be asked again', () => {
    assert.equal(reRequestDecision({ status: 'revoked' }, NOW), 'fresh');
});
