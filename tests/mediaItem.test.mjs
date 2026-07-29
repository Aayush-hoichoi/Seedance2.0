import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaItemFromUpload } from '../lib/seedance/mediaItem.mjs';
import { validateAggregate } from '../lib/seedance/limits.js';

test('uploaded video metadata survives into aggregate duration validation', () => {
    const slot = { kind: 'video', role: 'reference_video' };
    const first = mediaItemFromUpload(slot, 'first.mp4', { url: 'https://cdn/first.mp4', key: 'first' }, { durationSec: 8.1, width: 1920, height: 1080, fps: 24 });
    const second = mediaItemFromUpload(slot, 'second.mp4', { url: 'https://cdn/second.mp4', key: 'second' }, { durationSec: 8.1, width: 1920, height: 1080, fps: 24 });

    assert.equal(first.durationSec, 8.1);
    assert.equal(second.durationSec, 8.1);
    assert.match(validateAggregate([first, second]), /16\.2s/);
});

test('upload response cannot override trusted inspected metadata or slot identity', () => {
    const item = mediaItemFromUpload(
        { kind: 'video', role: 'reference_video' },
        'clip.mp4',
        { url: 'https://cdn/clip.mp4', key: 'clip', durationSec: 999, kind: 'image' },
        { durationSec: 7.5 },
    );

    assert.equal(item.kind, 'video');
    assert.equal(item.role, 'reference_video');
    assert.equal(item.durationSec, 7.5);
});
