// Fidelity: our column specs and vocabulary against the two hand-built
// workbooks themselves.
//
// This is the only test that checks the thing the requirement actually asks
// for — that the exported file is indistinguishable from the file people
// already use. Everything else verifies our own reasoning; this verifies it
// against the artefact.
//
// The workbooks live outside the repo (they are a user's files, not fixtures),
// so every test skips cleanly when they are absent. A skipped run is not a
// pass — when the files are present this is the highest-value test here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readSheet, sheetNames } from '../lib/ledger/xlsxRead.mjs';
import {
    MASTER_COLUMNS, VIDEO_COLUMNS, MASTER_REF_COLUMNS, VIDEO_REF_COLUMNS,
    AGGREGATE_COLUMNS, STORAGE_STATE, OUTPUT_STORED, OPEN_VIDEO_LABEL,
    PROVIDER_URL_EXPIRED, NO_DURABLE_KEY, NO_LINK_IN_POSTGRES,
} from '../lib/ledger/columns.mjs';
import { ACCEPTANCE_BASIS } from '../lib/ledger/sessions.mjs';
import { percent } from '../lib/ledger/workbooks.mjs';

const MASTER = '/Users/swapnanilm/Desktop/gen/logline-generations-master.xlsx';
const VIDEO = '/Users/swapnanilm/Desktop/gen/video-generations-all-time.xlsx';
const have = existsSync(MASTER) && existsSync(VIDEO);
const when = { skip: have ? false : 'reference workbooks not present on this machine' };

test('the master workbook has the sheets we reproduce', when, () => {
    assert.deepEqual(sheetNames(MASTER), [
        'All Generations', 'Downloaded Only', 'Reference Assets', 'Method & Caveats',
    ]);
});

test('the video workbook has the sheets we reproduce', when, () => {
    assert.deepEqual(sheetNames(VIDEO), [
        'Video Generations', 'Downloaded Only', 'Reference Assets',
        'By User', 'By Model', 'By Project', 'By Date', 'Storage Guide',
    ]);
});

test('MASTER_COLUMNS matches the real header, in order', when, () => {
    assert.deepEqual(readSheet(MASTER, 'All Generations')[0], MASTER_COLUMNS);
});

test('VIDEO_COLUMNS matches the real header, in order', when, () => {
    assert.deepEqual(readSheet(VIDEO, 'Video Generations')[0], VIDEO_COLUMNS);
});

test('the Downloaded Only sheets share their workbook’s shape', when, () => {
    assert.deepEqual(readSheet(MASTER, 'Downloaded Only')[0], MASTER_COLUMNS);
    assert.deepEqual(readSheet(VIDEO, 'Downloaded Only')[0], VIDEO_COLUMNS);
});

test('the Reference Assets sheets differ between the files, as ours do', when, () => {
    assert.deepEqual(readSheet(MASTER, 'Reference Assets')[0], MASTER_REF_COLUMNS);
    assert.deepEqual(readSheet(VIDEO, 'Reference Assets')[0], VIDEO_REF_COLUMNS);
});

test('all four roll-up sheets share one shape', when, () => {
    for (const [sheet, key] of [['By User', 'User'], ['By Model', 'Model'],
        ['By Project', 'Project'], ['By Date', 'Date (IST)']]) {
        assert.deepEqual(readSheet(VIDEO, sheet)[0], [key, ...AGGREGATE_COLUMNS], sheet);
    }
});

// --- vocabulary ---------------------------------------------------------------

function valuesIn(path, sheet, column) {
    const rows = readSheet(path, sheet);
    const i = rows[0].indexOf(column);
    assert.ok(i >= 0, `${sheet} has no column ${column}`);
    return new Set(rows.slice(1).map((r) => r[i] ?? ''));
}

test('Storage State uses exactly the three sentences the file uses', when, () => {
    assert.deepEqual(
        [...valuesIn(VIDEO, 'Video Generations', 'Storage State')].sort(),
        [STORAGE_STATE.CONFIRMED, STORAGE_STATE.EXPECTED, STORAGE_STATE.NOT_ARCHIVED].sort(),
    );
});

test('Output Stored? uses exactly the three words the file uses', when, () => {
    assert.deepEqual(
        [...valuesIn(MASTER, 'All Generations', 'Output Stored?')].sort(),
        [OUTPUT_STORED.CONFIRMED, OUTPUT_STORED.UNCONFIRMED, OUTPUT_STORED.IN_POSTGRES].sort(),
    );
});

test('every Acceptance Basis the files contain is one we can produce', when, () => {
    const ours = (n) => new Set([
        '', ACCEPTANCE_BASIS.RECORDED, ACCEPTANCE_BASIS.DISCARDED,
        ACCEPTANCE_BASIS.ONLY_SUCCESS, ACCEPTANCE_BASIS.SUPERSEDED,
        ACCEPTANCE_BASIS.FAILED, n,
        ...Array.from({ length: 200 }, (_, i) => ACCEPTANCE_BASIS.LAST_OF(i + 2)),
    ]);

    for (const v of valuesIn(VIDEO, 'Video Generations', 'Acceptance Basis')) {
        assert.ok(ours(ACCEPTANCE_BASIS.NO_SUCCESS).has(v), `video: unhandled basis ${JSON.stringify(v)}`);
    }
    for (const v of valuesIn(MASTER, 'All Generations', 'Acceptance Basis')) {
        assert.ok(ours(ACCEPTANCE_BASIS.NO_SUCCESS_MASTER).has(v), `master: unhandled basis ${JSON.stringify(v)}`);
    }
});

test('the two files really do word "no successful output" differently', when, () => {
    // Load-bearing: masterWorkbook() rewrites this one string, and if the files
    // ever agreed the rewrite would be dead code hiding a wrong assumption.
    assert.ok(valuesIn(VIDEO, 'Video Generations', 'Acceptance Basis').has(ACCEPTANCE_BASIS.NO_SUCCESS));
    assert.ok(valuesIn(MASTER, 'All Generations', 'Acceptance Basis').has(ACCEPTANCE_BASIS.NO_SUCCESS_MASTER));
});

test('Confidence, DOWNLOADED?, Liked? and Binned? vocabularies match', when, () => {
    assert.deepEqual([...valuesIn(MASTER, 'All Generations', 'Confidence')].sort(),
        ['', '—', 'High', 'Low', 'Medium', 'Recorded'].sort());
    for (const c of ['DOWNLOADED?', 'Liked?', 'Binned?']) {
        assert.deepEqual([...valuesIn(MASTER, 'All Generations', c)].sort(), ['YES', 'no'].sort(), c);
    }
});

test('Had Video Input is Yes/No/blank — capitalised unlike the others', when, () => {
    assert.deepEqual([...valuesIn(VIDEO, 'Video Generations', 'Had Video Input')].sort(),
        ['', 'No', 'Yes'].sort());
});

test('the fixed label strings are verbatim', when, () => {
    assert.ok(valuesIn(VIDEO, 'Video Generations', '▶ OPEN VIDEO').has(OPEN_VIDEO_LABEL));
    assert.ok(valuesIn(VIDEO, 'Video Generations', 'Provider URL (expires ~24h)').has(PROVIDER_URL_EXPIRED));
    assert.ok(valuesIn(VIDEO, 'Reference Assets', 'Durable Key').has(NO_DURABLE_KEY));
    assert.ok(valuesIn(MASTER, 'All Generations', 'OUTPUT LINK').has(NO_LINK_IN_POSTGRES));
});

test('Era and Media use the values we emit', when, () => {
    assert.deepEqual([...valuesIn(MASTER, 'All Generations', 'Era')].sort(), ['Gateway', 'Pre-gateway']);
    assert.deepEqual([...valuesIn(MASTER, 'All Generations', 'Media')].sort(), ['Image', 'Video']);
});

test('Success Rate is formatted the way our percent() formats it', when, () => {
    const seen = valuesIn(VIDEO, 'By Model', 'Success Rate');
    for (const v of seen) {
        assert.match(v, /^\d+(\.\d)?%$/, `unexpected rate format ${JSON.stringify(v)}`);
    }
    // Whole numbers drop the decimal: "100%", never "100.0%".
    assert.equal(percent(1, 1), '100%');
    assert.equal(percent(0, 5), '0%');
    assert.equal(percent(4469, 5345), '83.6%');
});
