// One-time backfill: build every historical ledger row into ledger_rows, then
// set the watermark so the live tick takes over cleanly.
//
//   node --env-file=.env.local scripts/ledger-backfill.mjs [--dry-run] [--no-mark-dirty]
//
//   --dry-run        compute and report, write nothing
//   --no-mark-dirty  fill ledger_rows but do NOT queue the rows for Excel.
//                    Use when the workbooks already hold this history and you
//                    only want the database side seeded — otherwise the first
//                    drain would rewrite ~9,000 rows through Graph one at a
//                    time, which is hours of sequential requests for no gain.
//
// Sessions are computed over the WHOLE history in one pass, exactly as the
// hand-built exports were, so the backfilled acceptance columns are directly
// comparable to them. scripts/ledger-verify.mjs does that comparison.

import { getDb } from '../lib/db/neon.js';
import { computeSessions } from '../lib/ledger/sessions.mjs';
import { ledgerTargets } from '../lib/ledger/targets.mjs';
import { writeWatermark, upsertLedgerRows } from '../lib/ledger/sync.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const markDirty = !args.includes('--no-mark-dirty');

const sql = await getDb();
if (!sql) { console.error('No DB — set DATABASE_URL (node --env-file=.env.local …).'); process.exit(1); }

const startedAt = new Date();
console.log('Reading generation_ledger…');
const rows = await sql`SELECT * FROM generation_ledger ORDER BY submitted_at ASC`;
console.log(`  ${rows.length} generation(s)`);

const byEra = rows.reduce((acc, r) => { acc[r.era] = (acc[r.era] || 0) + 1; return acc; }, {});
const byMedia = rows.reduce((acc, r) => { acc[r.media] = (acc[r.media] || 0) + 1; return acc; }, {});
const byStatus = rows.reduce((acc, r) => { acc[r.status || '(not recorded)'] = (acc[r.status || '(not recorded)'] || 0) + 1; return acc; }, {});
console.log(`  era:    ${JSON.stringify(byEra)}`);
console.log(`  media:  ${JSON.stringify(byMedia)}`);
console.log(`  status: ${JSON.stringify(byStatus)}`);

console.log('Computing sessions over the full history…');
computeSessions(rows);
const sessions = new Set(rows.map((r) => r.session_id).filter((s) => s && s !== '—'));
const accepted = rows.filter((r) => r.accepted_output === 'YES').length;
console.log(`  ${sessions.size} session(s), ${accepted} accepted output(s)`);

// The invariant worth asserting before anything is written: exactly one
// accepted output per session, unless the session has recorded downloads (in
// which case every downloaded row is accepted, on fact rather than inference).
const perSession = new Map();
for (const row of rows) {
    if (!row.session_id || row.session_id === '—') continue;
    if (!perSession.has(row.session_id)) perSession.set(row.session_id, []);
    perSession.get(row.session_id).push(row);
}
let multiInferred = 0;
for (const group of perSession.values()) {
    const inferred = group.filter((r) => r.accepted_output === 'YES' && r.confidence !== 'Recorded');
    if (inferred.length > 1) multiInferred += 1;
}
if (multiInferred) {
    console.error(`FAIL: ${multiInferred} session(s) carry more than one INFERRED accepted output.`);
    process.exit(1);
}
console.log('  ✓ at most one inferred acceptance per session');

if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    process.exit(0);
}

const targets = ledgerTargets();
console.log(`\nWriting ledger_rows${markDirty ? ` and queueing for ${targets.length} target(s)` : ' (not queueing for Excel)'}…`);

// Batched, for the same reason the tick batches: Neon speaks HTTP, so every
// statement is a round trip. A row at a time is three trips per row — about
// 1.3 rows/second, which turns this into a two-hour run for history the tick
// would otherwise stage in a minute. Chunked, it is a few hundred statements.
const SYNC_CHUNK = 500;

// DO NOTHING, never DO UPDATE: a row already queued for Excel keeps its dirty
// flag. The backfill seeds history; it does not re-decide what still needs
// writing out.
async function seedSyncState(sql, pairs, state) {
    for (let i = 0; i < pairs.length; i += SYNC_CHUNK) {
        const chunk = pairs.slice(i, i + SYNC_CHUNK);
        const params = [];
        const tuples = chunk.map(([rowKey, targetId]) => {
            const base = params.length;
            params.push(rowKey, targetId, state);
            return `($${base + 1},$${base + 2},$${base + 3},now())`;
        });
        await sql.query(
            `INSERT INTO ledger_sync (row_key, target_id, sync_state, updated_at)
             VALUES ${tuples.join(',')}
             ON CONFLICT (row_key, target_id) DO NOTHING`,
            params,
        );
    }
}

let written = 0;
const CHUNK = 200;
const syncState = markDirty ? 'dirty' : 'clean';
for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    // The tick's own writer, so a backfilled row and a ticked row are shaped
    // and keyed identically rather than merely similarly.
    await upsertLedgerRows(sql, chunk);

    const pairs = [];
    for (const row of chunk) {
        for (const t of targets) if (t.filter(row)) pairs.push([row.row_key, t.id]);
    }
    await seedSyncState(sql, pairs, syncState);

    written += chunk.length;
    process.stdout.write(`\r  ${written}/${rows.length}`);
}
process.stdout.write('\n');

// Set the watermark to when the read started, not to now: anything that
// changed WHILE the backfill ran must still be picked up by the first live
// tick. Re-processing a few rows is free; missing them is not.
await writeWatermark(sql, { at: startedAt, key: '' });
console.log(`Watermark set to ${startedAt.toISOString()} — the live tick takes over from here.`);
console.log('\nNext: node --env-file=.env.local scripts/ledger-verify.mjs <workbook.xlsx>');
process.exit(0);
