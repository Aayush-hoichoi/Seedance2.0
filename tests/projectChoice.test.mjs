import test from 'node:test';
import assert from 'node:assert/strict';
import { preferredProjectId, resolveProjectId, rememberProjectId, PROJECT_KEY } from '../lib/seedance/projectChoice.mjs';

// Two callers resolve the project at different moments — the bootstrap once
// /api/projects answers, and the draft restore at mount, which cannot wait.
// If they ever disagree the studio restores one project's draft while showing
// another, so these assert they agree.

const store = (value) => ({
    getItem: () => value,
    setItem() { this.written = arguments[1]; },
});
const items = [{ id: 5 }, { id: 9 }];

test('a ?project= deep-link beats the stored choice, in both resolvers', () => {
    const s = store('9');
    assert.equal(preferredProjectId('?project=5', s), 5);
    assert.equal(resolveProjectId(items, '?project=5', s), 5);
});

test('with no link, the stored choice wins — and both agree', () => {
    const s = store('9');
    assert.equal(preferredProjectId('', s), 9);
    assert.equal(resolveProjectId(items, '', s), 9);
});

test('a stored project the user no longer has falls back to the first granted', () => {
    // preferredProjectId cannot know this (it has no list) — the mount guess is
    // allowed to miss, and the effect reconciles once the list lands.
    const s = store('404');
    assert.equal(preferredProjectId('', s), 404);
    assert.equal(resolveProjectId(items, '', s), 5);
});

test('nothing stored and no link lands on the first granted project', () => {
    assert.equal(preferredProjectId('', store(null)), null);
    assert.equal(resolveProjectId(items, '', store(null)), 5);
});

test('no projects at all resolves to null rather than inventing one', () => {
    assert.equal(resolveProjectId([], '', store('9')), null);
    assert.equal(resolveProjectId(null, '', store('9')), null);
});

test('blocked storage never throws — it just forgets', () => {
    const hostile = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
    assert.equal(preferredProjectId('', hostile), null);
    assert.equal(resolveProjectId(items, '', hostile), 5);
    assert.doesNotThrow(() => rememberProjectId(9, hostile));
    assert.doesNotThrow(() => rememberProjectId(9, null));
});

test('garbage in the link or the store is ignored, not coerced', () => {
    assert.equal(preferredProjectId('?project=abc', store(null)), null);
    assert.equal(preferredProjectId('?project=0', store(null)), null); // 0 is not an id
    assert.equal(preferredProjectId('', store('not-a-number')), null);
});

test('the key is exported so no caller has to spell it', () => {
    assert.equal(PROJECT_KEY, 'seedance:project'); // must match what already ships
});
