import test from 'node:test';
import assert from 'node:assert/strict';

import { tosPresignExpired } from '../lib/seedance/tosPresign.mjs';

// A real TOS presign: issue stamp + lifetime, both in the query string.
const url = (stamp, expires) =>
    `https://bucket.tos-ap.example.com/uploads/1-ab-x.jpg?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Date=${stamp}&X-Tos-Expires=${expires}&X-Tos-Signature=deadbeef`;
const stampAt = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const HOUR = 3600 * 1000;
const now = Date.parse('2026-09-10T12:00:00Z');

test('a signature issued minutes ago is live', () => {
    assert.equal(tosPresignExpired(url(stampAt(now - 5 * 60 * 1000), 43200), now), false);
});

test('a 12h signature from yesterday is expired — the case that failed generations', () => {
    assert.equal(tosPresignExpired(url(stampAt(now - 20 * HOUR), 43200), now), true);
});

test('renewal starts just BEFORE the deadline, so a URL cannot die mid-render', () => {
    const issued = now - 43200 * 1000 + 60 * 1000; // 60s of life left, inside the 300s skew
    assert.equal(tosPresignExpired(url(stampAt(issued), 43200), now), true);
    const comfortable = now - 43200 * 1000 + 30 * 60 * 1000; // 30 min left
    assert.equal(tosPresignExpired(url(stampAt(comfortable), 43200), now), false);
});

test('anything that is not a presigned URL is left alone', () => {
    // asset:// has its own branch in rehydrateStaleAssetRefs; a library pick and
    // a plain CDN link carry no signature to judge. None may be called expired.
    for (const u of ['asset://abc123', 'https://cdn.example.com/plain.jpg', 'data:image/jpeg;base64,AAA', '', null, undefined]) {
        assert.equal(tosPresignExpired(u, now), false, `${u} must not be treated as expired`);
    }
});

test('a malformed stamp or lifetime is not guessed at', () => {
    assert.equal(tosPresignExpired(url('not-a-date', 43200), now), false);
    assert.equal(tosPresignExpired(url(stampAt(now - 20 * HOUR), 'soon'), now), false);
});
