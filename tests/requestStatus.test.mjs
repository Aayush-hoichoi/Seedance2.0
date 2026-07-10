import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStatus } from '../lib/access/requestStatus.mjs';

test('maps each action to its status', () => {
    assert.equal(nextStatus('request'), 'pending');
    assert.equal(nextStatus('approve'), 'approved');
    assert.equal(nextStatus('revoke'), 'revoked');
});

test('throws on an unknown action', () => {
    assert.throws(() => nextStatus('delete'), /Unknown action/);
});
