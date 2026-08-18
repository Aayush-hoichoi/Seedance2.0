import test from 'node:test';
import assert from 'node:assert/strict';
import { creatorOrderBy } from '../lib/access/db.js';

// The bug this guards: the gallery's creators sidebar was ranked by generation
// COUNT, so "5m ago" sat below "8/1/2026" and the list looked unsorted. The
// sidebar asks for 'recent', which must lead with last_at.
test('the sidebar ordering leads with last activity, newest first', () => {
    const clause = creatorOrderBy('recent');
    assert.match(clause, /^s\.last_at DESC NULLS LAST/);
    // Creators who never generated carry a NULL last_at and must not float up.
    assert.match(clause, /NULLS LAST/);
});

test('the default (admin roster) ordering still leads with volume', () => {
    assert.match(creatorOrderBy('volume'), /^coalesce\(s\.generations, 0\) DESC/);
    assert.match(creatorOrderBy(undefined), /^coalesce\(s\.generations, 0\) DESC/);
});

// The clause is concatenated into the SQL text, so anything off the whitelist
// must collapse to the default rather than reach the query.
test('an unknown order falls back to the default instead of passing through', () => {
    for (const bad of ['; DROP TABLE users', 'created_at', '', null, {}]) {
        assert.equal(creatorOrderBy(bad), creatorOrderBy('volume'));
    }
});

// Both orderings must fully determine the row order — a tie on the lead key
// falls through to the other key and then to signup time.
test('both orderings tie-break down to a unique key', () => {
    for (const order of ['recent', 'volume']) {
        const clause = creatorOrderBy(order);
        assert.match(clause, /s\.last_at/);
        assert.match(clause, /s\.generations/);
        assert.match(clause, /u\.created_at DESC$/);
    }
});
