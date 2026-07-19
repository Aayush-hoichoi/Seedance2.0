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

// --- tier-aware verdicts (wantedTier + ladder) -------------------------------

const LADDER = ['480p', '720p', '1080p', '4k'];

test('tier: wanted at/below the live cap is covered — no new request', () => {
    assert.equal(reRequestDecision({ status: 'approved', max_resolution: '1080p' }, NOW, '720p', LADDER), 'covered');
    assert.equal(reRequestDecision({ status: 'approved', max_resolution: '1080p' }, NOW, '1080p', LADDER), 'covered');
});

test('tier: wanted above the live cap is an upgrade', () => {
    assert.equal(reRequestDecision({ status: 'approved', max_resolution: '1080p' }, NOW, '4k', LADDER), 'upgrade');
});

test('tier: an uncapped grant covers everything', () => {
    assert.equal(reRequestDecision({ status: 'approved', max_resolution: null }, NOW, '4k', LADDER), 'covered');
});

test('tier: duplicate upgrade ask (same tier already parked) is pending, no re-ping', () => {
    assert.equal(
        reRequestDecision({ status: 'approved', max_resolution: '720p', pending_max_resolution: '4k' }, NOW, '4k', LADDER),
        'pending',
    );
});

test('tier: a different tier over a parked upgrade re-parks (last ask wins)', () => {
    assert.equal(
        reRequestDecision({ status: 'approved', max_resolution: '720p', pending_max_resolution: '4k' }, NOW, '1080p', LADDER),
        'upgrade',
    );
});

test('tier: expired grant re-opens fresh even when asked with a tier', () => {
    assert.equal(
        reRequestDecision({ status: 'approved', max_resolution: '720p', expires_at: '2026-07-16T00:00:00Z' }, NOW, '4k', LADDER),
        'fresh',
    );
});

test('tier: still-pending ask at a DIFFERENT tier bumps (re-ping); same tier stays a duplicate', () => {
    assert.equal(reRequestDecision({ status: 'pending', max_resolution: '1080p' }, NOW, '4k', LADDER), 'pending_bump');
    assert.equal(reRequestDecision({ status: 'pending', max_resolution: '4k' }, NOW, '4k', LADDER), 'pending');
    assert.equal(reRequestDecision({ status: 'pending', max_resolution: '4k' }, NOW, null, LADDER), 'pending');
});

test('tier: case-insensitive comparison across token styles', () => {
    assert.equal(reRequestDecision({ status: 'approved', max_resolution: '2K' }, NOW, '2k', ['1K', '2K', '4K']), 'covered');
    assert.equal(reRequestDecision({ status: 'approved', max_resolution: '2k' }, NOW, '4K', ['1K', '2K', '4K']), 'upgrade');
});

test('tier: without a ladder the legacy approved verdict holds', () => {
    assert.equal(reRequestDecision({ status: 'approved', max_resolution: '720p' }, NOW, '4k', null), 'approved');
});
