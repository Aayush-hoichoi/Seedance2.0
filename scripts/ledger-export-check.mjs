// Generate both workbooks from the live database and diff them against the
// hand-built originals, sheet by sheet and column by column.
//
//   node --env-file=.env.local scripts/ledger-export-check.mjs \
//        ~/Desktop/gen/logline-generations-master.xlsx \
//        ~/Desktop/gen/video-generations-all-time.xlsx
//
// This runs the exact code path the export route runs. It is the answer to
// "is the download the same as the file we already use?" — asked of the real
// data rather than of fixtures.

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../lib/db/neon.js';
import { computeSessions } from '../lib/ledger/sessions.mjs';
import { shapeLedgerRow } from '../lib/ledger/shape.mjs';
import { masterWorkbook, videoWorkbook } from '../lib/ledger/workbooks.mjs';
import { buildXlsx } from '../lib/ledger/xlsxWrite.mjs';
import { readSheet, sheetNames } from '../lib/ledger/xlsxRead.mjs';

const [masterRef, videoRef] = process.argv.slice(2);

const sql = await getDb();
if (!sql) { console.error('No DB — set DATABASE_URL (node --env-file=.env.local …).'); process.exit(1); }

console.log('Reading generation_ledger…');
const rows = await sql`SELECT * FROM generation_ledger ORDER BY submitted_at ASC NULLS FIRST`;
console.log(`  ${rows.length} generation(s)`);
if (!rows.length) {
    console.error('The ledger view returned nothing. Has the schema migrated (getDb runs it) and is there data?');
    process.exit(1);
}

computeSessions(rows);
for (const row of rows) row.cells = shapeLedgerRow(row);

const bucket = process.env.TOS_BUCKET?.trim() || 'seedance-studio-assets';
const region = process.env.TOS_REGION?.trim() || 'ap-southeast-1';

const out = tmpdir();
const built = {
    master: { path: join(out, 'built-master.xlsx'), sheets: masterWorkbook(rows), ref: masterRef },
    video: {
        path: join(out, 'built-video.xlsx'),
        sheets: videoWorkbook(rows.filter((r) => r.media === 'Video'), { bucket, region }),
        ref: videoRef,
    },
};

let failures = 0;
for (const [id, spec] of Object.entries(built)) {
    writeFileSync(spec.path, buildXlsx({ sheets: spec.sheets }));
    console.log(`\n── ${id} ─────────────────────────────────────────────`);
    console.log(`  wrote ${spec.path}`);
    for (const s of spec.sheets) console.log(`    ${s.name}: ${s.rows.length} rows x ${s.columns.length} cols`);

    if (!spec.ref) { console.log('  (no reference file given — structure only)'); continue; }

    const ours = sheetNames(spec.path);
    const theirs = sheetNames(spec.ref);
    if (JSON.stringify(ours) !== JSON.stringify(theirs)) {
        console.error(`  ✗ sheet names differ\n     ours:   ${ours.join(' | ')}\n     theirs: ${theirs.join(' | ')}`);
        failures += 1;
    } else {
        console.log(`  ✓ sheet names match (${ours.length})`);
    }

    for (const name of theirs.filter((t) => ours.includes(t))) {
        const a = readSheet(spec.path, name)[0];
        const b = readSheet(spec.ref, name)[0];
        if (JSON.stringify(a) !== JSON.stringify(b)) {
            console.error(`  ✗ "${name}" header differs`);
            const width = Math.max(a.length, b.length);
            for (let i = 0; i < width; i += 1) {
                if (a[i] !== b[i]) console.error(`      col ${i}: ours=${JSON.stringify(a[i])} theirs=${JSON.stringify(b[i])}`);
            }
            failures += 1;
        } else {
            console.log(`  ✓ "${name}" header matches (${a.length} cols)`);
        }
    }

    // Row counts will differ — the originals are a frozen snapshot and the
    // database has moved on. Report, never fail.
    const mainSheet = theirs[0];
    const oursRows = readSheet(spec.path, mainSheet).length - 1;
    const theirsRows = readSheet(spec.ref, mainSheet).length - 1;
    console.log(`  · "${mainSheet}" rows: ours ${oursRows}, snapshot ${theirsRows}, delta ${oursRows - theirsRows}`);
}

console.log(`\n${failures ? `✗ ${failures} structural difference(s)` : '✓ structure identical to the reference workbooks'}`);
process.exit(failures ? 1 : 0);
