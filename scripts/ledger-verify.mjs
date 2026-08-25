// Reconcile the rebuilt ledger against a hand-built workbook.
//
//   node --env-file=.env.local scripts/ledger-verify.mjs \
//        /Users/…/logline-generations-master.xlsx "All Generations"
//
// The two exported workbooks are a known-good answer over 9,133 rows, produced
// by a completely independent query. That makes them the only real test the
// generation_ledger view will ever get — and it expires, because every new
// generation widens the gap between the frozen file and the live database.
// Run this immediately after the backfill, while the overlap is still total.
//
// Rows created after the workbook's snapshot are reported separately and are
// NOT failures: the file is a snapshot, the database is not.

import { getDb } from '../lib/db/neon.js';
import { readSheet } from '../lib/ledger/xlsxRead.mjs';
import { VIDEO_COLUMNS } from '../lib/ledger/columns.mjs';

const [file, sheetName = 'All Generations'] = process.argv.slice(2);
if (!file) {
    console.error('usage: ledger-verify.mjs <workbook.xlsx> [sheet name]');
    process.exit(1);
}

const sql = await getDb();
if (!sql) { console.error('No DB — set DATABASE_URL.'); process.exit(1); }

console.log(`Reading ${file} · sheet "${sheetName}"…`);
const sheet = readSheet(file, sheetName);
const header = sheet[0] || [];
const body = sheet.slice(1);
console.log(`  ${body.length} row(s), ${header.length} column(s)`);

// The exports keyed on Task ID; the ledger keys on the invariant Row Key. Map
// between them the same way the view does: a provider task id when one exists,
// otherwise job:<id>. This is exactly the mapping that lets the 898 blank-key
// rows in the video workbook be identified at all.
const taskCol = header.indexOf('Task ID');
const statusCol = header.indexOf('Status');
const eraCol = header.indexOf('Era');
if (taskCol < 0) { console.error('No "Task ID" column — cannot reconcile.'); process.exit(1); }

const sheetKeys = new Map();
let blankKeys = 0;
for (const row of body) {
    const taskId = row[taskCol] || '';
    if (!taskId) { blankKeys += 1; continue; }
    sheetKeys.set(taskId, {
        status: statusCol >= 0 ? row[statusCol] : null,
        era: eraCol >= 0 ? row[eraCol] : null,
    });
}
if (blankKeys) {
    console.log(`  ${blankKeys} row(s) have NO Task ID and cannot be matched — these are the`);
    console.log('    generations that failed before the provider accepted them. In the rebuilt');
    console.log('    ledger they carry a job:<id> row key and are fully addressable.');
}

const allRows = await sql`
    SELECT row_key, era, media, status, submitted_at,
           coalesce(cells->>'Task ID', '') AS task_id
    FROM ledger_rows`;

// The video workbook is video-only by construction. Reconciling all of
// ledger_rows against it would count every image as unexplained — an
// apples-to-oranges denominator that buries any real discrepancy under 1,500
// rows of noise. Scope the ledger side to the media the sheet actually
// carries; the master sheet carries both, so nothing is dropped there.
//
// That workbook has no Media column to read — being video-only is exactly why
// it does not need one — so the header itself is the only thing that can
// identify it. VIDEO_COLUMNS is the repo's definition of that header, pinned
// to this very file by tests/ledgerWorkbookFidelity.test.mjs.
const mediaCol = header.indexOf('Media');
const isVideoWorkbook = VIDEO_COLUMNS.length === header.length
    && VIDEO_COLUMNS.every((name, i) => name === header[i]);
const sheetMedia = isVideoWorkbook
    ? new Set(['Video'])
    : mediaCol >= 0
        ? new Set(body.map((r) => r[mediaCol]).filter(Boolean))
        : new Set();
const ledger = sheetMedia.size
    ? allRows.filter((r) => sheetMedia.has(r.media))
    : allRows;

console.log(`ledger_rows: ${allRows.length} row(s)`
    + (ledger.length === allRows.length
        ? ''
        : ` · ${ledger.length} after scoping to ${[...sheetMedia].join(' + ')}`));

// Matching stays over every row, so a row whose media disagrees with the sheet
// still resolves rather than being reported as missing.
const ledgerByTask = new Map();
for (const r of allRows) {
    const key = r.task_id || r.row_key.replace(/^pre:/, '');
    ledgerByTask.set(key, r);
}

const snapshot = body.reduce((max, row) => {
    const d = row[header.indexOf('Date (IST)')];
    return d && d > max ? d : max;
}, '');

let matched = 0;
const matchedKeys = new Set();
const missingFromLedger = [];
const statusMismatch = [];
for (const [taskId, sheetRow] of sheetKeys) {
    const found = ledgerByTask.get(taskId);
    if (!found) { missingFromLedger.push(taskId); continue; }
    matched += 1;
    matchedKeys.add(found.row_key);
    const ledgerStatus = found.status || '(not recorded)';
    if (sheetRow.status && sheetRow.status !== ledgerStatus) {
        statusMismatch.push({ taskId, sheet: sheetRow.status, ledger: ledgerStatus });
    }
}

const sheetDate = (row) => (row.submitted_at
    ? new Date(row.submitted_at).toISOString().slice(0, 10)
    : '');

const newerThanSnapshot = ledger.filter((r) => sheetDate(r) > snapshot).length;

// The sheet records a DATE, not a timestamp, so a row generated later on the
// snapshot's own day is indistinguishable from one generated before the export
// ran — the file was saved at some unrecorded hour of that date. Counting
// those as unexplained made a clean reconciliation look like it had a hundred
// stray rows. They are newer-than-the-file too; the date column just cannot
// prove it.
const sameDayAsSnapshot = ledger.filter((r) => (
    sheetDate(r) === snapshot && !matchedKeys.has(r.row_key)
)).length;

const extraInLedger = ledger.length - matched - newerThanSnapshot - sameDayAsSnapshot;

console.log('\n── reconciliation ──────────────────────────────────');
console.log(`  matched                      ${matched}`);
console.log(`  in sheet, missing from DB    ${missingFromLedger.length}`);
console.log(`  unmatchable (blank Task ID)  ${blankKeys}`);
console.log(`  newer than the snapshot      ${newerThanSnapshot}   (expected — the file is frozen)`);
console.log(`  same day as the snapshot     ${sameDayAsSnapshot}   (expected — the sheet dates, it does not clock)`);
console.log(`  otherwise unaccounted for    ${extraInLedger}`);
console.log(`  status mismatches            ${statusMismatch.length}`);

if (missingFromLedger.length) {
    console.log('\n  first 10 missing from the ledger:');
    for (const t of missingFromLedger.slice(0, 10)) console.log(`    ${t}`);
}
if (statusMismatch.length) {
    console.log('\n  first 10 status mismatches:');
    for (const m of statusMismatch.slice(0, 10)) console.log(`    ${m.taskId}: sheet=${m.sheet} ledger=${m.ledger}`);
}

// A row in the frozen sheet that the live view cannot produce is a real defect
// in generation_ledger — the past does not change. Everything else is drift.
const failed = missingFromLedger.length > 0;
console.log(`\n${failed ? '✗ FAILED' : '✓ PASSED'} — the view ${failed ? 'cannot reproduce' : 'reproduces'} the frozen workbook.`);
process.exit(failed ? 1 : 0);
