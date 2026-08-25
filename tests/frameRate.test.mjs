import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateFrameRate } from '../lib/seedance/frameRate.mjs';

test('a skipped startup frame does not halve a 25 fps video', () => {
    // Chrome's exact callback sequence for Test File_S_10.mp4: the decoder
    // skipped one frame while starting, then delivered every 40 ms frame.
    const samples = [
        { mediaTime: 0.00, presentedFrames: 1 },
        { mediaTime: 0.08, presentedFrames: 2 },
        { mediaTime: 0.12, presentedFrames: 3 },
        { mediaTime: 0.16, presentedFrames: 4 },
        { mediaTime: 0.20, presentedFrames: 5 },
    ];

    assert.ok(Math.abs(estimateFrameRate(samples) - 25) < 0.001);
});
