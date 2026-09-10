import test from 'node:test';
import assert from 'node:assert/strict';
import { preferredProjectId, resolveProjectId, rememberProjectId, syncProjectParam, PROJECT_KEY } from '../lib/seedance/projectChoice.mjs';

// Two callers resolve the project at different moments — the bootstrap once
// /api/projects answers, and the draft restore at mount, which cannot wait.
// If they ever disagree the studio restores one project's draft while showing
// another, so these assert they agree.

const store = (value) => ({
    getItem: () => value,
    setItem() { this.written = arguments[1]; },
});
const items = [{ id: 5 }, { id: 9 }];

test('a ?project= deep-link beats the stored choice, in both resolvers', () => {
    const s = store('9');
    assert.equal(preferredProjectId('?project=5', s), 5);
    assert.equal(resolveProjectId(items, '?project=5', s), 5);
});

test('with no link, the stored choice wins — and both agree', () => {
    const s = store('9');
    assert.equal(preferredProjectId('', s), 9);
    assert.equal(resolveProjectId(items, '', s), 9);
});

test('a stored project the user no longer has falls back to the first granted', () => {
    // preferredProjectId cannot know this (it has no list) — the mount guess is
    // allowed to miss, and the effect reconciles once the list lands.
    const s = store('404');
    assert.equal(preferredProjectId('', s), 404);
    assert.equal(resolveProjectId(items, '', s), 5);
});

test('nothing stored and no link lands on the first granted project', () => {
    assert.equal(preferredProjectId('', store(null)), null);
    assert.equal(resolveProjectId(items, '', store(null)), 5);
});

test('no projects at all resolves to null rather than inventing one', () => {
    assert.equal(resolveProjectId([], '', store('9')), null);
    assert.equal(resolveProjectId(null, '', store('9')), null);
});

test('blocked storage never throws — it just forgets', () => {
    const hostile = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
    assert.equal(preferredProjectId('', hostile), null);
    assert.equal(resolveProjectId(items, '', hostile), 5);
    assert.doesNotThrow(() => rememberProjectId(9, hostile));
    assert.doesNotThrow(() => rememberProjectId(9, null));
});

test('garbage in the link or the store is ignored, not coerced', () => {
    assert.equal(preferredProjectId('?project=abc', store(null)), null);
    assert.equal(preferredProjectId('?project=0', store(null)), null); // 0 is not an id
    assert.equal(preferredProjectId('', store('not-a-number')), null);
});

test('the key is exported so no caller has to spell it', () => {
    assert.equal(PROJECT_KEY, 'seedance:project'); // must match what already ships
});

// ── the reload-changes-my-project bug ────────────────────────────────────────

test('a stale ?project= naming a revoked project falls through to the stored one', () => {
    // Regressed once: taking the first PRESENT candidate and then validating it
    // discarded a perfectly good stored choice and landed on items[0]. The rule
    // is first VALID candidate, not first candidate.
    assert.equal(resolveProjectId(items, '?project=404', store('9')), 9);
    // …and only when neither survives does the first granted project apply.
    assert.equal(resolveProjectId(items, '?project=404', store('777')), 5);
});

test('switching project rewrites a stale ?project= so a reload cannot revert it', () => {
    // /projects opens /seedance?project=5; the user then picks 9 in the studio.
    let replaced = null;
    const loc = { href: 'https://x.test/seedance?project=5' };
    const hist = { state: null, replaceState: (_s, _t, url) => { replaced = url; } };
    syncProjectParam(9, loc, hist);
    assert.match(replaced, /project=9/);
    // The rewritten URL now resolves to the project actually chosen.
    assert.equal(resolveProjectId(items, new URL(replaced).search, store('9')), 9);
});

test('it leaves a URL with no ?project= alone rather than adding noise', () => {
    let replaced = null;
    const hist = { state: null, replaceState: (_s, _t, url) => { replaced = url; } };
    syncProjectParam(9, { href: 'https://x.test/seedance' }, hist);
    assert.equal(replaced, null);
    // Nothing to correct: with no param the stored choice already governs.
    assert.equal(resolveProjectId(items, '', store('9')), 9);
});

test('a param that already agrees is not rewritten', () => {
    let calls = 0;
    syncProjectParam(9, { href: 'https://x.test/seedance?project=9' }, { state: null, replaceState: () => { calls += 1; } });
    assert.equal(calls, 0);
});

test('syncProjectParam never throws, whatever it is handed', () => {
    assert.doesNotThrow(() => syncProjectParam(9, null, null));
    assert.doesNotThrow(() => syncProjectParam(null, { href: 'https://x.test/?project=1' }, { replaceState() {} }));
    assert.doesNotThrow(() => syncProjectParam(9, { href: 'not a url' }, { replaceState() {} }));
    assert.doesNotThrow(() => syncProjectParam(9, { href: 'https://x.test/?project=1' }, {}));
});
