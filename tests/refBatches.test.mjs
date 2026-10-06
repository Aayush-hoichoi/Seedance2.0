// Reference batches: one Generate click fires one generation per batch, each
// batch a complete reference set. Batch k≥2 lives in mediaByRole under
// synthetic `batch<k>:<role>` keys; these helpers are the whole contract
// between the prompt bar (rows, uploads) and the studio (one payload per set).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    batchRole, parseBatchRole, batchIndices, batchMedia, withBatchMedia,
    nextBatchIndex, mediaBatches, imageRefBatches,
} from '../lib/seedance/refBatches.mjs';

const img = (name) => ({ kind: 'image', role: 'reference_image', name });

test('parseBatchRole splits synthetic keys and passes real roles through', () => {
    assert.deepEqual(parseBatchRole('reference_image'), { k: 0, role: 'reference_image' });
    assert.deepEqual(parseBatchRole('batch2:reference_image'), { k: 2, role: 'reference_image' });
    // A role that merely contains 'batch' is not synthetic.
    assert.deepEqual(parseBatchRole('batch_variant_1'), { k: 0, role: 'batch_variant_1' });
});

test('batchIndices: sparse, sorted, empty batches ignored', () => {
    const m = {
        reference_image: [img('a')],
        [batchRole(3, 'reference_image')]: [img('c')],
        [batchRole(1, 'reference_video')]: [{ kind: 'video', role: 'reference_video' }],
        [batchRole(2, 'reference_image')]: [], // emptied → gone
    };
    assert.deepEqual(batchIndices(m), [1, 3]);
    assert.equal(nextBatchIndex(m), 4);
    assert.equal(nextBatchIndex({}), 1);
});

test('batchMedia views one batch under real roles', () => {
    const m = {
        reference_image: [img('base')],
        [batchRole(1, 'reference_image')]: [img('b1a'), img('b1b')],
        [batchRole(2, 'reference_image')]: [img('b2')],
    };
    assert.deepEqual(batchMedia(m, 0), { reference_image: [img('base')] });
    assert.deepEqual(batchMedia(m, 1), { reference_image: [img('b1a'), img('b1b')] });
    assert.deepEqual(batchMedia(m, 2), { reference_image: [img('b2')] });
});

test('withBatchMedia round-trips a view and drops emptied roles', () => {
    const m = { reference_image: [img('base')], [batchRole(1, 'reference_image')]: [img('b1')] };
    // Rewrite batch 1 from its own view (what MediaButtons' remove/reorder do).
    const edited = withBatchMedia(m, 1, { reference_image: [img('b1-new')], reference_video: [] });
    assert.deepEqual(edited, { reference_image: [img('base')], [batchRole(1, 'reference_image')]: [img('b1-new')] });
    // Emptying the whole view removes the batch; other batches untouched.
    const gone = withBatchMedia(edited, 1, {});
    assert.deepEqual(gone, { reference_image: [img('base')] });
    assert.deepEqual(batchIndices(gone), []);
});

test('mediaBatches lists every reference set in output order', () => {
    const m = {
        reference_image: [img('base')],
        [batchRole(2, 'reference_image')]: [img('b2')],
    };
    assert.deepEqual(mediaBatches(m), [
        { reference_image: [img('base')] },
        { reference_image: [img('b2')] },
    ]);
    // No extra batches → exactly the base set (the ×N selector's domain).
    assert.deepEqual(mediaBatches({ reference_image: [img('base')] }), [{ reference_image: [img('base')] }]);
});

test('imageRefBatches: base group first, empty extra groups skipped', () => {
    assert.deepEqual(imageRefBatches([{ name: 'a' }], [[{ name: 'b' }], []]), [[{ name: 'a' }], [{ name: 'b' }]]);
    assert.deepEqual(imageRefBatches([], null), [[]]);
});
