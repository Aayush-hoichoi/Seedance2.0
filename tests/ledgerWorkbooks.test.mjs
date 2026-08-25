// The two workbook builders end-to-end: shaped rows in, a real .xlsx out,
// read back with the same parser that reads the originals.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeSessions, ACCEPTANCE_BASIS } from '../lib/ledger/sessions.mjs';
import { shapeLedgerRow } from '../lib/ledger/shape.mjs';
import { masterWorkbook, videoWorkbook, aggregate, percent } from '../lib/ledger/workbooks.mjs';
import { buildXlsx } from '../lib/ledger/xlsxWrite.mjs';
import { readSheet, sheetNames } from '../lib/ledger/xlsxRead.mjs';
import { MASTER_COLUMNS, VIDEO_COLUMNS, MASTER_REF_COLUMNS, VIDEO_REF_COLUMNS } from '../lib/ledger/columns.mjs';

const dir = mkdtempSync(join(tmpdir(), 'ledger-wb-'));
const BASE = Date.parse('2026-08-24T04:30:00Z'); // 10:00 IST

let n = 0;
function row(over = {}) {
    n += 1;
    return {
        row_key: `job:${n}`,
        era: 'Gateway',
        media: 'Video',
        submitted_at: new Date(BASE + n * 60_000),
        user_id: 'u1',
        user_name: 'Shinjini Nandy',
        user_email: 'shinjini.nandy@hoichoi.tv',
        project_name: 'Hooliganism',
        model_id: 'seedance-2.0',
        status: 'succeeded',
        generation_id: n,
        task_id: `cgt-${n}`,
        resolution: '1080p',
        duration: 10,
        ratio: '16:9',
        has_video_input: false,
        prompt: 'a wide cinematic shot of a train crossing a bridge at dusk',
        user_prompt: 'a wide cinematic shot of a train crossing a bridge at dusk',
        input_refs: [],
        binned: false,
        output_key: `videos/cgt-${n}.mp4`,
        output_confirmed: true,
        cost_usd: 3.75,
        downloads: 0,
        likes: 0,
        ...over,
    };
}

function prepare(rows) {
    computeSessions(rows);
    for (const r of rows) r.cells = shapeLedgerRow(r);
    return rows;
}

function write(sheets, name) {
    const path = join(dir, `${name}.xlsx`);
    writeFileSync(path, buildXlsx({ sheets }));
    return path;
}

test('the master workbook has the four sheets, in order', () => {
    const path = write(masterWorkbook(prepare([row(), row({ media: 'Image' })])), 'master');
    assert.deepEqual(sheetNames(path), [
        'All Generations', 'Downloaded Only', 'Reference Assets', 'Method & Caveats',
    ]);
    assert.deepEqual(readSheet(path, 'All Generations')[0], MASTER_COLUMNS);
    assert.deepEqual(readSheet(path, 'Reference Assets')[0], MASTER_REF_COLUMNS);
});

test('the video workbook has the eight sheets, in order', () => {
    const path = write(videoWorkbook(prepare([row(), row()]), { bucket: 'b', region: 'r' }), 'video');
    assert.deepEqual(sheetNames(path), [
        'Video Generations', 'Downloaded Only', 'Reference Assets',
        'By User', 'By Model', 'By Project', 'By Date', 'Storage Guide',
    ]);
    assert.deepEqual(readSheet(path, 'Video Generations')[0], VIDEO_COLUMNS);
    assert.deepEqual(readSheet(path, 'Reference Assets')[0], VIDEO_REF_COLUMNS);
});

test('the master workbook holds both media; the video one holds only video', () => {
    const rows = prepare([row(), row({ media: 'Image' }), row()]);
    const master = readSheet(write(masterWorkbook(rows), 'm2'), 'All Generations');
    assert.equal(master.length - 1, 3);

    const video = videoWorkbook(rows.filter((r) => r.media === 'Video'), {});
    assert.equal(video[0].rows.length, 2);
});

test('Downloaded Only really is the downloaded subset', () => {
    const rows = prepare([row({ downloads: 2 }), row(), row()]);
    const path = write(masterWorkbook(rows), 'm3');
    const only = readSheet(path, 'Downloaded Only');
    assert.equal(only.length - 1, 1);
    assert.equal(only[1][MASTER_COLUMNS.indexOf('DOWNLOADED?')], 'YES');
});

test('the master rewrites the one string the two files word differently', () => {
    const rows = prepare([row({ status: 'failed', output_key: null, output_confirmed: false })]);
    assert.equal(rows[0].cells['Acceptance Basis'], ACCEPTANCE_BASIS.NO_SUCCESS);

    const master = masterWorkbook(rows)[0].rows[0];
    assert.equal(master['Acceptance Basis'], ACCEPTANCE_BASIS.NO_SUCCESS_MASTER);
    assert.equal(master['Acceptance Basis'], 'No successful output');

    const video = videoWorkbook(rows, {})[0].rows[0];
    assert.equal(video['Acceptance Basis'], 'No successful output in this session');
});

test('reference assets expand to one row per asset', () => {
    const rows = prepare([row({
        input_refs: [
            { role: 'reference image', name: '1.png', tosKey: 'uploads/a-1.png' },
            { role: 'reference video', name: '2.mp4' },
        ],
    })]);
    const path = write(masterWorkbook(rows), 'm4');
    const refs = readSheet(path, 'Reference Assets');
    assert.equal(refs.length - 1, 2);
    assert.equal(refs[1][MASTER_REF_COLUMNS.indexOf('Ref #')], '1');
    assert.equal(refs[1][MASTER_REF_COLUMNS.indexOf('Role')], 'reference image');
    assert.equal(refs[2][MASTER_REF_COLUMNS.indexOf('File Name')], '2.mp4');

    // The video sheet spells out a missing durable key; the master leaves blank.
    const vrefs = videoWorkbook(rows, {})[2].rows;
    assert.equal(vrefs[0]['Durable Key'], 'uploads/a-1.png');
    assert.equal(vrefs[1]['Durable Key'], '(no durable key)');
});

test('roll-ups count succeeded, failed, downloaded and confirmed separately', () => {
    const rows = prepare([
        row(),                                                    // succeeded, confirmed
        row({ status: 'failed', output_key: null, output_confirmed: false }),
        row({ downloads: 1 }),
        row({ status: 'queued', output_key: null, output_confirmed: false }),
    ]);
    const [g] = aggregate(rows, 'Model', (r) => r.model_id);
    assert.equal(g.Generations, 4);
    assert.equal(g.Succeeded, 2);
    assert.equal(g.Failed, 1, 'queued is neither succeeded nor failed');
    assert.equal(g.Downloaded, 1);
    assert.equal(g['Archive Confirmed'], 2);
    assert.equal(g['Success Rate'], '50%');
});

test('roll-ups sort by volume, busiest first', () => {
    const rows = prepare([
        row({ model_id: 'a' }),
        row({ model_id: 'b' }), row({ model_id: 'b' }),
    ]);
    const out = aggregate(rows, 'Model', (r) => r.model_id);
    assert.equal(out[0].Model, 'b');
    assert.equal(out[1].Model, 'a');
});

test('money sums exactly, instead of drifting a cent at a time', () => {
    // 1.005 has no exact binary representation, so the naive
    // Math.round(n * 100) / 100 gives 1, not 1.01.
    const one = aggregate(prepare([row({ cost_usd: 1.005 })]), 'Model', () => 'm');
    assert.equal(one[0]['Total Cost (USD)'], 1.01);

    // And a long sum must not accumulate float error. 0.1 x 1000 is the
    // classic case: naive addition lands on 99.99999999999859.
    const many = aggregate(
        prepare(Array.from({ length: 1000 }, () => row({ cost_usd: 0.1 }))),
        'Model', () => 'm',
    );
    assert.equal(many[0]['Total Cost (USD)'], 100);
});

test('By User is labelled "Name <email>"', () => {
    const rows = prepare([row()]);
    const byUser = videoWorkbook(rows, {})[3].rows;
    assert.equal(byUser[0].User, 'Shinjini Nandy <shinjini.nandy@hoichoi.tv>');
});

test('percent drops the decimal on whole numbers', () => {
    assert.equal(percent(1, 1), '100%');
    assert.equal(percent(3, 4), '75%');
    assert.equal(percent(4469, 5345), '83.6%');
    assert.equal(percent(0, 0), '0%');
});

test('the narrative sheets carry computed totals, not fixed text', () => {
    const rows = prepare([row(), row({ downloads: 1 })]);
    const method = masterWorkbook(rows)[3].rows;
    const totals = method.find((r) => r.Item === 'Totals — generations');
    assert.equal(totals.Detail, '2');
    const dl = method.find((r) => r.Item === 'DOWNLOADED?');
    assert.match(dl.Detail, /1 generations were downloaded/);
});

test('the video workbook carries hyperlinks; the master does not', () => {
    const rows = prepare([row({
        input_refs: [{ role: 'reference image', name: '1.png', tosKey: 'uploads/a-1.png' }],
    })]);
    const video = videoWorkbook(rows, { bucket: 'b', region: 'r' });
    const built = buildXlsx({ sheets: video });
    assert.ok(built.length > 0);

    // The originals differ this way too: master is plain text, video links.
    const master = masterWorkbook(rows);
    assert.ok(!master[0].links, 'the master sheet declares no hyperlinks');
    assert.ok(video[0].links, 'the video sheet declares hyperlinks');
});

test('an empty ledger still produces both workbooks', () => {
    const m = write(masterWorkbook([]), 'empty-m');
    assert.deepEqual(readSheet(m, 'All Generations')[0], MASTER_COLUMNS);
    const v = write(videoWorkbook([], { bucket: 'b', region: 'r' }), 'empty-v');
    assert.deepEqual(readSheet(v, 'Video Generations')[0], VIDEO_COLUMNS);
    assert.equal(sheetNames(v).length, 8);
});
