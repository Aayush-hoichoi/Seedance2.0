import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedreamSize } from '../lib/gateway/providers/byteplus.mjs';

// Seedream 5.0 rejects sizes below 3,686,400 px or with an edge over 4096
// (verified live). Every studio ratio × tier must map inside that box.
const MIN = 3_686_400;
const MAX = 4096;
const RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'];

test('every ratio × tier is a valid Seedream size', () => {
    for (const tier of ['2K', '4K']) {
        for (const ratio of RATIOS) {
            const [w, h] = seedreamSize(ratio, tier).split('x').map(Number);
            assert.ok(w * h >= MIN, `${tier} ${ratio} = ${w}x${h} is ${w * h}px < min`);
            assert.ok(w <= MAX && h <= MAX, `${tier} ${ratio} edge exceeds ${MAX}`);
        }
    }
});

test('a 1:1 2K request is a clean 2048 square', () => {
    assert.equal(seedreamSize('1:1', '2K'), '2048x2048');
});

test('unsupported tier (1K) and missing ratio still clear the pixel floor', () => {
    const [w1, h1] = seedreamSize('16:9', '1K').split('x').map(Number); // 1K → 2K budget
    assert.ok(w1 * h1 >= MIN);
    const [w2, h2] = seedreamSize(null, '2K').split('x').map(Number); // no ratio → square
    assert.equal(w2, h2);
});

test('orientation follows the aspect ratio', () => {
    const [lw, lh] = seedreamSize('16:9', '2K').split('x').map(Number);
    assert.ok(lw > lh, 'landscape');
    const [pw, ph] = seedreamSize('9:16', '4K').split('x').map(Number);
    assert.ok(ph > pw, 'portrait');
});
