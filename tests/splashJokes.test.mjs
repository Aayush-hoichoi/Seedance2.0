// The splash used a memoryless Math.random(), so the same joke came back every
// few reloads. pickFresh is the guard: nothing repeats until the pool is spent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pickFresh, HELLOS, JOKES } from '../lib/splash/jokes.mjs';

test('walks the whole pool before any joke repeats', () => {
    const pool = ['a', 'b', 'c', 'd'];
    let seen = [];
    const drawn = [];
    for (let i = 0; i < pool.length; i++) {
        const r = pickFresh(pool, seen);
        drawn.push(r.pick);
        seen = r.seen;
    }
    assert.deepEqual([...drawn].sort(), [...pool].sort(), 'every item shown exactly once');
    assert.equal(new Set(drawn).size, pool.length, 'no repeats within a cycle');
});

test('starts a fresh cycle once the pool is exhausted', () => {
    const pool = ['a', 'b'];
    const { pick, seen } = pickFresh(pool, ['a', 'b']);
    assert.ok(pool.includes(pick));
    assert.deepEqual(seen, [pick], 'history resets to just the new pick');
});

test('an unseen item is always preferred over a seen one', () => {
    // rand() = 0 would pick 'a' from the full pool; 'a' is seen, so it must not.
    const { pick } = pickFresh(['a', 'b'], ['a'], () => 0);
    assert.equal(pick, 'b');
});

test('rand() returning 1 does not index past the end', () => {
    const { pick } = pickFresh(['a', 'b', 'c'], [], () => 1);
    assert.equal(pick, 'c');
});

test('an empty or junk pool yields nothing instead of throwing', () => {
    assert.equal(pickFresh([], []).pick, null);
    assert.equal(pickFresh(null, null).pick, null);
    assert.equal(pickFresh([null, ''], []).pick, null);
});

test('the shipped pools are big and free of duplicates', () => {
    assert.ok(JOKES.length >= 60, `expected a deep joke pool, got ${JOKES.length}`);
    assert.ok(HELLOS.length >= 40, `expected a deep greeting pool, got ${HELLOS.length}`);
    assert.equal(new Set(JOKES).size, JOKES.length, 'duplicate joke in the pool');
    assert.equal(new Set(HELLOS).size, HELLOS.length, 'duplicate greeting in the pool');
    assert.ok(HELLOS.every((h) => h.includes('{name}')), 'every greeting must take a name');
});
