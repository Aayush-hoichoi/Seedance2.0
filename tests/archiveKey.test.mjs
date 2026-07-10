import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveKeyForTask } from '../lib/seedance/archiveKey.mjs';

test('maps a task id to its archived video key', () => {
    assert.equal(archiveKeyForTask('cgt-20260710-abc'), 'videos/cgt-20260710-abc.mp4');
});

test('sanitizes characters TOS keys disallow', () => {
    assert.equal(archiveKeyForTask('a/b\\c d'), 'videos/a_b_c_d.mp4');
});

test('rejects empty and non-string input', () => {
    assert.equal(archiveKeyForTask(''), null);
    assert.equal(archiveKeyForTask('   '), null);
    assert.equal(archiveKeyForTask(null), null);
    assert.equal(archiveKeyForTask(42), null);
});
