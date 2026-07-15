// One-off: enforce the org default-access policy on an EXISTING database.
// Seedance 2.0 Mini, Seedance 1.5 Pro + Nano Banana 2 stay org-default (open
// to everyone, matching the non-gated models in lib/seedance/constants.js);
// every other model (Seedance 2.0 full, Fast, Nano Banana Pro, Seedream 5.0 Pro)
// moves behind permission — users request access, admins approve. The seed uses
// ON CONFLICT DO NOTHING, so a previously-seeded row keeps its old is_default;
// this reconciles the live catalog. Idempotent — safe to re-run.
// Run:  node --env-file=.env.local scripts/set-default-models.mjs

import { getDb } from '../lib/db/neon.js';

const OPEN = ['seedance-2.0-mini', 'seedance-1.5-pro', 'nano-banana-2'];
const GATED = ['seedance-2.0', 'seedance-2.0-fast', 'nano-banana-pro', 'seedream-5.0-pro'];

const sql = await getDb();
if (!sql) {
    console.error('No database — set DATABASE_URL (e.g. node --env-file=.env.local …).');
    process.exit(1);
}

const opened = await sql`UPDATE models SET is_default = true
    WHERE id = ANY(${OPEN}) AND is_default = false RETURNING id`;
const gated = await sql`UPDATE models SET is_default = false
    WHERE id = ANY(${GATED}) AND is_default = true RETURNING id`;

const state = await sql`SELECT id, is_default FROM models ORDER BY category, id`;
console.log(`Opened ${opened.length}, gated ${gated.length}. Catalog default-access now:`);
for (const m of state) console.log(`  ${m.is_default ? '✓ default ' : '· request '} ${m.id}`);
process.exit(0);
