import test from 'node:test';
import assert from 'node:assert/strict';
import { moveItem } from '../lib/seedance/reorder.mjs';

test('moveItem moves a reference forward without mutating the source', () => {
    const source = ['Image 1', 'Image 2', 'Image 3'];
    assert.deepEqual(moveItem(source, 0, 2), ['Image 2', 'Image 3', 'Image 1']);
    assert.deepEqual(source, ['Image 1', 'Image 2', 'Image 3']);
});

test('moveItem moves a reference backward', () => {
    assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
});

test('moveItem safely ignores invalid positions', () => {
    assert.deepEqual(moveItem(['a', 'b'], -1, 1), ['a', 'b']);
    assert.deepEqual(moveItem(['a', 'b'], 0, 5), ['a', 'b']);
});
