import test from 'node:test';
import assert from 'node:assert/strict';
import {
    computeSessions, affectedWindow, tokenSetSimilarity, sessionIdFor,
    SESSION_GAP_MS, NO_SESSION,
} from '../lib/ledger/sessions.mjs';

const BASE = Date.parse('2026-08-24T10:00:00Z');
const PROMPT = 'a wide cinematic shot of a train crossing a bridge at dusk';

function row(n, over = {}) {
    return {
        row_key: `job:${n}`,
        user_id: 'u1',
        project_id: 7,
        media: 'Video',
        status: 'succeeded',
        prompt: PROMPT,
        downloads: 0,
        submitted_at: new Date(BASE + n * 60_000),
        ...over,
    };
}

test('a gap longer than 45 minutes starts a new session', () => {
    const first = row(1);
    const rows = computeSessions([
        first,
        row(2, { submitted_at: new Date(first.submitted_at.getTime() + SESSION_GAP_MS + 1) }),
    ]);
    assert.notEqual(rows[0].session_id, rows[1].session_id);
    assert.equal(rows[0].try_number, 1);
    assert.equal(rows[1].try_number, 1);
});

test('a gap of EXACTLY 45 minutes stays in one session', () => {
    // "more than 45 minutes" is strict. Pinning the boundary because it is the
    // kind of detail that silently changes when someone refactors the check.
    const first = row(1);
    const rows = computeSessions([
        first,
        row(2, { submitted_at: new Date(first.submitted_at.getTime() + SESSION_GAP_MS) }),
    ]);
    assert.equal(rows[0].session_id, rows[1].session_id);
});

test('a gap shorter than 45 minutes keeps one session', () => {
    const rows = computeSessions([row(1), row(2), row(3)]);
    assert.equal(rows[0].session_id, rows[2].session_id);
    assert.deepEqual(rows.map((r) => r.try_number), [1, 2, 3]);
    assert.deepEqual(rows.map((r) => r.tries_in_session), [3, 3, 3]);
});

test('a different user, project or media never shares a session', () => {
    const rows = computeSessions([
        row(1),
        row(2, { user_id: 'u2' }),
        row(3, { project_id: 9 }),
        row(4, { media: 'Image' }),
    ]);
    assert.equal(new Set(rows.map((r) => r.session_id)).size, 4);
});

test('an unrelated prompt starts a new session even seconds later', () => {
    const rows = computeSessions([
        row(1),
        row(2, { prompt: 'close up of a bowl of soup on a wooden table' }),
    ]);
    assert.notEqual(rows[0].session_id, rows[1].session_id);
});

test('similarity is measured against the session anchor, not the previous row', () => {
    // Each step is similar to the one before it, but the last is unlike the
    // first. Anchoring stops a session drifting arbitrarily far from its start.
    const rows = computeSessions([
        row(1, { prompt: 'red car on a highway at noon' }),
        row(2, { prompt: 'red car on a highway at night' }),
        row(3, { prompt: 'blue boat on a canal at night' }),
    ]);
    assert.equal(rows[0].session_id, rows[1].session_id);
    assert.notEqual(rows[0].session_id, rows[2].session_id);
});

test('exactly one inferred acceptance per session — the last success', () => {
    const rows = computeSessions([row(1), row(2), row(3)]);
    const accepted = rows.filter((r) => r.accepted_output === 'YES');
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].row_key, 'job:3');
});

test('a NEW success demotes the previous winner — the bug per-row upserts cause', () => {
    const before = computeSessions([row(1), row(2)]);
    assert.equal(before[1].accepted_output, 'YES');
    assert.equal(before[1].confidence, 'Medium'); // 2 successes

    // The same session, recomputed with one more success in it.
    const after = computeSessions([row(1), row(2), row(3)]);
    assert.equal(after[1].accepted_output, '', 'job:2 must lose its acceptance');
    assert.equal(after[2].accepted_output, 'YES');
    assert.equal(after.filter((r) => r.accepted_output === 'YES').length, 1);
});

test('failures never win acceptance and never count as successes', () => {
    const rows = computeSessions([
        row(1, { status: 'succeeded' }),
        row(2, { status: 'failed' }),
        row(3, { status: 'timed_out' }),
    ]);
    assert.equal(rows[0].accepted_output, 'YES');
    assert.equal(rows[1].accepted_output, '');
    assert.equal(rows[2].accepted_output, '');
    assert.equal(rows[0].successes_in_session, 1);
    assert.equal(rows[0].confidence, 'High');
});

test('a session with no success at all accepts nothing', () => {
    const rows = computeSessions([row(1, { status: 'failed' }), row(2, { status: 'failed' })]);
    assert.equal(rows.filter((r) => r.accepted_output === 'YES').length, 0);
    assert.deepEqual(rows.map((r) => r.confidence), ['—', '—']);
});

test('a recorded download outranks inference, and suppresses it entirely', () => {
    const rows = computeSessions([row(1, { downloads: 2 }), row(2), row(3)]);
    assert.equal(rows[0].accepted_output, 'YES');
    assert.equal(rows[0].confidence, 'Recorded');
    // job:3 is the last success but must NOT also be accepted — otherwise the
    // session carries a recorded YES and an inferred YES at once.
    assert.equal(rows[2].accepted_output, '');
    assert.equal(rows.filter((r) => r.accepted_output === 'YES').length, 1);
});

test('confidence tiers follow the success count', () => {
    const tier = (n) => computeSessions(Array.from({ length: n }, (_, i) => row(i + 1)))
        .find((r) => r.accepted_output === 'YES').confidence;
    assert.equal(tier(1), 'High');
    assert.equal(tier(2), 'Medium');
    assert.equal(tier(5), 'Medium');
    assert.equal(tier(6), 'Low');
});

test('pre-gateway rows carry no user and are left unsegmented', () => {
    const rows = computeSessions([{
        row_key: 'pre:cgt-1', user_id: null, project_id: null, media: 'Video',
        status: null, prompt: PROMPT, downloads: 0, submitted_at: new Date(BASE),
    }]);
    assert.equal(rows[0].session_id, NO_SESSION);
    assert.equal(rows[0].try_number, '');
    assert.equal(rows[0].confidence, '', 'blank, not "—": the question is unanswerable, not answered no');
});

test('session ids are stable when an earlier row is backfilled', () => {
    const later = computeSessions([row(5), row(6)]);
    const idBefore = later[0].session_id;

    // A row from a DIFFERENT session arrives later (well outside the gap).
    const withEarlier = computeSessions([
        row(1, { submitted_at: new Date(BASE - SESSION_GAP_MS * 3) }),
        row(5), row(6),
    ]);
    const idAfter = withEarlier.find((r) => r.row_key === 'job:5').session_id;
    assert.equal(idAfter, idBefore, 'a sequential counter would have renumbered this');
});

test('sessionIdFor is derived from the anchor key, zero-padded and sortable', () => {
    assert.equal(sessionIdFor('job:3644'), 'S-003644');
    assert.ok(sessionIdFor('job:1') < sessionIdFor('job:2'));
    assert.equal(sessionIdFor('pre:cgt-abc'), 'S-cgt-abc');
});

test('tokenSetSimilarity: identical, disjoint, and empty', () => {
    assert.equal(tokenSetSimilarity('a red car', 'a red car'), 1);
    assert.equal(tokenSetSimilarity('a red car', 'blue boat sails'), 0);
    assert.equal(tokenSetSimilarity('', 'anything'), 0, 'an absent prompt is not evidence of belonging');
});

test('affectedWindow widens on BOTH sides of the changed rows', () => {
    const [w] = affectedWindow([row(10)]);
    const at = BASE + 10 * 60_000;
    assert.equal(w.from.getTime(), at - SESSION_GAP_MS);
    assert.equal(w.to.getTime(), at + SESSION_GAP_MS);
    assert.equal(w.userId, 'u1');
    assert.equal(w.media, 'Video');
});

test('affectedWindow emits one window per (user, project, media)', () => {
    const windows = affectedWindow([row(1), row(2), row(3, { user_id: 'u2' }), row(4, { media: 'Image' })]);
    assert.equal(windows.length, 3);
});
