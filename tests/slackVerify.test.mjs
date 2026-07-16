import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifySlackSignature } from '../lib/slack/verify.mjs';

const secret = 'test-signing-secret';
const sign = (ts, body) => 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');

test('accepts a correctly-signed, fresh request', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = 'payload=%7B%7D';
    assert.equal(verifySlackSignature({ signingSecret: secret, signature: sign(ts, body), timestamp: ts, rawBody: body }), true);
});

test('rejects a wrong signature', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    assert.equal(verifySlackSignature({ signingSecret: secret, signature: 'v0=deadbeef', timestamp: ts, rawBody: 'x' }), false);
    // right shape, wrong secret
    const forged = 'v0=' + crypto.createHmac('sha256', 'other').update(`v0:${ts}:x`).digest('hex');
    assert.equal(verifySlackSignature({ signingSecret: secret, signature: forged, timestamp: ts, rawBody: 'x' }), false);
});

test('rejects a stale timestamp (replay guard)', () => {
    const ts = String(Math.floor(Date.now() / 1000) - 600); // 10 min old
    const body = 'x';
    assert.equal(verifySlackSignature({ signingSecret: secret, signature: sign(ts, body), timestamp: ts, rawBody: body }), false);
});

test('rejects when secret/signature/timestamp is missing', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    assert.equal(verifySlackSignature({ signingSecret: '', signature: sign(ts, 'x'), timestamp: ts, rawBody: 'x' }), false);
    assert.equal(verifySlackSignature({ signingSecret: secret, signature: '', timestamp: ts, rawBody: 'x' }), false);
    assert.equal(verifySlackSignature({ signingSecret: secret, signature: sign(ts, 'x'), timestamp: '', rawBody: 'x' }), false);
});
