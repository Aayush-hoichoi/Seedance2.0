import test from 'node:test';
import assert from 'node:assert/strict';
import { formatGenerationTime } from '../lib/seedance/generationTime.mjs';

test('generation time measures submission to completion with second rounding', () => {
    assert.equal(formatGenerationTime('2026-10-09T10:44:29.417Z', '2026-10-09T10:55:46.941Z'), '11m 18s');
    assert.equal(formatGenerationTime('2026-10-07T08:21:11.587Z', '2026-10-07T08:35:15.792Z'), '14m 04s');
    assert.equal(formatGenerationTime('2026-10-09T16:14:29.417+05:30', '2026-10-09T10:55:46.941Z'), '11m 18s');
});

test('legacy, unfinished, invalid, and reversed timestamps never fabricate a duration', () => {
    for (const [start, end] of [[null, null], [undefined, '2026-10-09'], ['2026-10-09', null], ['', '2026-10-09'], ['bad', '2026-10-09'], ['2026-10-09', 'bad'], ['2026-10-09', '2026-10-08']]) {
        assert.equal(formatGenerationTime(start, end), null);
    }
});

test('short and hour-long completions retain seconds across minute boundaries', () => {
    const start = Date.parse('2026-10-09T00:00:00Z');
    assert.equal(formatGenerationTime(start, start + 42500), '43s');
    assert.equal(formatGenerationTime(start, start + 59900), '1m 00s');
    assert.equal(formatGenerationTime(start, start + 3723000), '1h 02m 03s');
    assert.equal(formatGenerationTime(start, start), '0s');
});
