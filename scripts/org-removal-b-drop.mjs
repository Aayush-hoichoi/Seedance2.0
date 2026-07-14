// Org removal — PHASE B (drop). Run this AFTER the org-less build is live in
// production (so nothing reads/writes org_id anymore). Drops every org_id column
// (CASCADE removes the old UNIQUE(org_id,name), the org-prefixed indexes, and
// the old usage_rollups_daily PK — the phase-A no-org unique indexes take over)
// and finally the now-empty organizations table. Idempotent. Run:
//   node --env-file=.env.local scripts/org-removal-b-drop.mjs

import { getDb } from '../lib/db/neon.js';

const sql = await getDb();
if (!sql) { console.error('No database — set DATABASE_URL.'); process.exit(1); }

const statements = [
    `ALTER TABLE projects            DROP COLUMN IF EXISTS org_id CASCADE`,
    `ALTER TABLE api_keys            DROP COLUMN IF EXISTS scope_org_id CASCADE`,
    `ALTER TABLE quotas              DROP COLUMN IF EXISTS org_id CASCADE`,
    `ALTER TABLE billing_events      DROP COLUMN IF EXISTS org_id CASCADE`,
    `ALTER TABLE jobs                DROP COLUMN IF EXISTS org_id CASCADE`,
    `ALTER TABLE events              DROP COLUMN IF EXISTS org_id CASCADE`,
    `ALTER TABLE usage_rollups_daily DROP COLUMN IF EXISTS org_id CASCADE`,
    `ALTER TABLE usage_events        DROP COLUMN IF EXISTS org_id`,
    `DROP TABLE IF EXISTS organizations`,
];

let ok = 0;
for (const stmt of statements) {
    try {
        await sql.query(stmt);
        ok += 1;
        console.log('  ✓', stmt);
    } catch (err) {
        console.error('  ✗', stmt, '\n     →', err.message);
    }
}

// Sanity: confirm no org_id columns remain on the governed tables.
const leftover = await sql`SELECT table_name, column_name FROM information_schema.columns
    WHERE column_name IN ('org_id', 'scope_org_id')
      AND table_name IN ('projects','api_keys','quotas','billing_events','jobs','events','usage_rollups_daily')`;
console.log(`Phase B done: ${ok}/${statements.length} statements applied.`);
console.log(leftover.length ? `  ⚠ org columns still present: ${JSON.stringify(leftover)}` : '  ✓ no org_id columns remain on governed tables.');
process.exit(0);
