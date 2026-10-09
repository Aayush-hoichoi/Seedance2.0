import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoPreviewQueue } from '../lib/seedance/videoPreviewQueue.mjs';

test('a gallery page decodes only two first frames at once, starting the next after completion', () => {
    const queue = createVideoPreviewQueue();
    const started = [];
    const finishes = [];
    for (let i = 0; i < 60; i += 1) queue.enqueue((finish) => { started.push(i); finishes[i] = finish; });
    assert.deepEqual(started, [0, 1]);
    finishes[0]();
    assert.deepEqual(started, [0, 1, 2]);
    finishes[0](); // duplicate media events must not release a second slot
    assert.deepEqual(started, [0, 1, 2]);
    finishes[1]();
    assert.deepEqual(started, [0, 1, 2, 3]);
});

test('cards scrolled away before their slot opens never start media requests', () => {
    const queue = createVideoPreviewQueue(1);
    const started = [];
    let first;
    queue.enqueue((finish) => { started.push('first'); first = finish; });
    const cancel = queue.enqueue(() => started.push('offscreen'));
    queue.enqueue(() => started.push('visible'));
    cancel();
    first();
    assert.deepEqual(started, ['first', 'visible']);
});

test('an active timeout or unmount releases its slot once and late callbacks are harmless', () => {
    const queue = createVideoPreviewQueue(1);
    const started = [];
    let late;
    const cancel = queue.enqueue((finish) => { late = finish; });
    queue.enqueue(() => started.push('next'));
    queue.enqueue(() => started.push('last'));
    cancel();
    late();
    cancel();
    assert.deepEqual(started, ['next']);
});
