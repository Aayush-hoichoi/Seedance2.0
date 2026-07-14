// Org removal — PHASE A (relax). Run this BEFORE deploying the org-less code.
// Everything here is additive / relaxing, so the CURRENTLY-DEPLOYED code keeps
// working unchanged: NOT NULL is only loosened, and the new org-less ON CONFLICT
// targets (unique indexes) are created alongside the old ones. After this runs
// and the new build is live, run scripts/org-removal-b-drop.mjs to drop the
// columns. Idempotent. Run:
//   node --env-file=.env.local scripts/org-removal-a-relax.mjs

import { getDb } from '../lib/db/neon.js';

const sql = await getDb();
if (!sql) { console.error('No database — set DATABASE_URL.'); process.exit(1); }

const statements = [
    // New code omits org_id on insert — these columns must accept NULL first.
    `ALTER TABLE projects        ALTER COLUMN org_id DROP NOT NULL`,
    `ALTER TABLE quotas          ALTER COLUMN org_id DROP NOT NULL`,
    `ALTER TABLE billing_events  ALTER COLUMN org_id DROP NOT NULL`,
    `ALTER TABLE jobs            ALTER COLUMN org_id DROP NOT NULL`,
    `ALTER TABLE events          ALTER COLUMN org_id DROP NOT NULL`,
    // usage_rollups_daily.org_id is in the primary key, so it can't be made
    // nullable yet. Give it a default so the new cron (which omits org_id)
    // still satisfies the PK until phase B drops the column.
    `ALTER TABLE usage_rollups_daily ALTER COLUMN org_id SET DEFAULT ''`,
    // Org-less ON CONFLICT targets the new code needs (safe: single tenant, so
    // names and rollup keys are already unique without org_id).
    `CREATE UNIQUE INDEX IF NOT EXISTS projects_name_key ON projects (name)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS usage_rollups_daily_no_org
        ON usage_rollups_daily (day, project_id, user_id, model_id, provider_id)`,
    // Time-range scans (usageForQuotas / usageRollup) no longer prefix by org.
    `CREATE INDEX IF NOT EXISTS billing_events_created ON billing_events (created_at)`,
];

let ok = 0;
for (const stmt of statements) {
    try {
        await sql.query(stmt);
        ok += 1;
        console.log('  ✓', stmt.replace(/\s+/g, ' ').slice(0, 72));
    } catch (err) {
        console.error('  ✗', stmt.replace(/\s+/g, ' ').slice(0, 72), '\n     →', err.message);
    }
}
console.log(`Phase A done: ${ok}/${statements.length} statements applied. Deploy the org-less code, then run phase B.`);
process.exit(0);
