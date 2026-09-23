// One-off: register the post-production tools (lib/tools/catalog.mjs) as
// catalog rows on an existing DB, so access requests and Console → Budgets can
// target them. seedGateway() does the same on fresh installs. Idempotent.
// is_default=false — tools are permission-gated.
// Run:  node --env-file=.env.local scripts/insert-tool-models.mjs

import { getDb } from '../lib/db/neon.js';
import { TOOL_CATALOG } from '../lib/tools/catalog.mjs';

const sql = await getDb();
if (!sql) { console.error('No database — set DATABASE_URL.'); process.exit(1); }
for (const t of TOOL_CATALOG) {
    await sql`INSERT INTO models (id, display_name, category, is_default, active)
        VALUES (${t.id}, ${t.display}, 'tool', false, true) ON CONFLICT DO NOTHING`;
}
console.log(await sql`SELECT id, display_name, category, is_default, active FROM models WHERE category = 'tool'`);
