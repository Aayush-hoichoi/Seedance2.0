// Exporting the current view: which rows the file holds, and — the part that
// actually matters — that narrowing the view never changes what a row says.
//
// The session columns are computed across a row's siblings, so the order of
// "compute sessions" and "apply the filter" is the whole correctness of a
// filtered export. These tests exist to stop that order being swapped by
// someone who reasonably assumes filtering early is just an optimisation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { selectExportRows } from '../lib/ledger/exportRows.mjs';
import { rowMatches } from '../lib/ledger/filters.mjs';

// A session is (user_id, project_id, media), within 45 minutes, with prompt
// similarity to the session anchor at or above 0.50 — so every row here shares
// one identical prompt. Without that the rows land in separate sessions and
// none of them can renumber another, which is precisely the thing under test.
const PROMPT = 'a wide cinematic shot of a train crossing a bridge at dusk';

const projectIds = new Map();
const idFor = (name) => {
    if (!projectIds.has(name)) projectIds.set(name, projectIds.size + 1);
    return projectIds.get(name);
};

let seq = 0;
function row({ model, status = 'succeeded', minutes = 0, user = 'a@b.tv', project = 'Alpha', media = 'Video' }) {
    seq += 1;
    return {
        row_key: `job:${seq}`,
        era: 'Gateway',
        media,
        status,
        submitted_at: new Date(Date.UTC(2026, 7, 1, 10, minutes)),
        user_id: user,
        user_name: 'A Person',
        user_email: user,
        project_id: idFor(project),
        project_name: project,
        prompt: PROMPT,
        model_id: model,
        provider_id: 'byteplus',
        attempt: 1,
        generation_id: seq,
        task_id: `cgt-${seq}`,
        downloads: 0,
        likes: 0,
        input_refs: [],
        output_key: status === 'succeeded' ? `videos/cgt-${seq}.mp4` : null,
        output_confirmed: status === 'succeeded',
        updated_at: new Date(Date.UTC(2026, 7, 1, 10, minutes)),
    };
}

test('an unfiltered export is every row, unchanged', () => {
    const rows = [row({ model: 'm1' }), row({ model: 'm2' })];
    const out = selectExportRows(rows);
    assert.equal(out.length, 2);
    assert.ok(out[0].cells, 'rows must come back shaped');
});

test('filtering to one model does NOT renumber that model’s tries', () => {
    // Four tries in one session, alternating models. m1 is tries 1 and 3 of 4.
    const rows = [
        row({ model: 'm1', status: 'failed', minutes: 0 }),
        row({ model: 'm2', status: 'failed', minutes: 1 }),
        row({ model: 'm1', status: 'failed', minutes: 2 }),
        row({ model: 'm2', status: 'succeeded', minutes: 3 }),
    ];

    const all = selectExportRows(rows.map((r) => ({ ...r })));
    const truth = all.map((r) => [r.cells.Model, r.cells['Try #'], r.cells['Tries in Session']]);

    const filtered = selectExportRows(rows.map((r) => ({ ...r })), { filters: { model: 'm1' } });
    assert.equal(filtered.length, 2, 'two m1 rows');

    // The m1 rows must keep the try numbers they have in the full history.
    const expected = truth.filter(([model]) => model === 'm1');
    const actual = filtered.map((r) => [r.cells.Model, r.cells['Try #'], r.cells['Tries in Session']]);
    assert.deepEqual(actual, expected,
        'a filtered row must carry its real position in the session, not a renumbered one');
    assert.equal(actual[0][2], 4, 'Tries in Session stays 4 — the session had four tries');
});

test('filtering cannot promote a superseded row to the accepted output', () => {
    // Two successes in one session: the later one wins, the earlier is
    // Superseded. Filter the winner out and the loser must NOT be promoted.
    const rows = [
        row({ model: 'm1', status: 'succeeded', minutes: 0 }),
        row({ model: 'm2', status: 'succeeded', minutes: 5 }),
    ];

    const all = selectExportRows(rows.map((r) => ({ ...r })));
    const [first, second] = all;
    assert.equal(second.cells['Accepted Output'], 'YES', 'the later success is the accepted one');
    assert.equal(first.cells['Accepted Output'], '', 'the earlier one was superseded');

    const filtered = selectExportRows(rows.map((r) => ({ ...r })), { filters: { model: 'm1' } });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].cells['Accepted Output'], '',
        'the superseded row must stay superseded even when the row that beat it is not in the file');
});

test('the media scope drops rows without touching the survivors', () => {
    const rows = [
        row({ model: 'm1', media: 'Video', minutes: 0 }),
        row({ model: 'm1', media: 'Image', minutes: 1 }),
    ];
    const out = selectExportRows(rows, { media: 'Video' });
    assert.equal(out.length, 1);
    assert.equal(out[0].cells.Media, 'Video');
});

test('the three filters and the search narrow the export the same way they narrow the list', () => {
    const rows = [
        row({ model: 'm1', user: 'a@b.tv', project: 'Alpha' }),
        row({ model: 'm1', user: 'c@d.tv', project: 'Alpha' }),
        row({ model: 'm2', user: 'a@b.tv', project: 'Alpha' }),
        row({ model: 'm1', user: 'a@b.tv', project: 'Beta' }),
    ];
    const out = selectExportRows(rows, {
        filters: { model: 'm1', user: 'a@b.tv', project: 'Alpha' },
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].cells.Project, 'Alpha');
});

test('rowMatches reads the same columns the dropdowns filter on', () => {
    const cells = { Model: 'seedance-2.0', 'User Email': 'a@b.tv', Project: 'Alpha' };
    assert.equal(rowMatches(cells, { filters: { model: 'seedance-2.0' } }), true);
    assert.equal(rowMatches(cells, { filters: { model: 'seedance-2.0-fast' } }), false,
        'exact, so a longer model name is not a match');
    assert.equal(rowMatches(cells, { filters: { user: 'a@b.tv', project: 'Alpha' } }), true);
    assert.equal(rowMatches(cells, { filters: { user: 'a@b.tv', project: 'Beta' } }), false);
});

test('free text matches case-insensitively, as ILIKE does', () => {
    const cells = { 'PROMPT (exact)': 'A Train At Dusk', Model: 'm1' };
    assert.equal(rowMatches(cells, { q: 'train' }), true);
    assert.equal(rowMatches(cells, { q: 'TRAIN' }), true);
    assert.equal(rowMatches(cells, { q: 'boat' }), false);
});
