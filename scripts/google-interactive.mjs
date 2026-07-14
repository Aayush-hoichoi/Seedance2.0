// One-off: switch the Google image routes (Nano Banana Pro / 2) from the async
// Batch API to interactive (synchronous) generateContent on an existing DB.
// The seed uses ON CONFLICT DO NOTHING, so a previously-seeded route keeps its
// old mode; this reconciles the live catalog. Idempotent.
// Run:  node --env-file=.env.local scripts/google-interactive.mjs

import { getDb } from '../lib/db/neon.js';

const sql = await getDb();
if (!sql) { console.error('No database — set DATABASE_URL.'); process.exit(1); }

const routes = await sql`UPDATE provider_routes SET mode = 'interactive', timeout_seconds = 300
    WHERE provider_id = 'google' AND mode <> 'interactive' RETURNING id`;

const state = await sql`SELECT m.id, pr.mode, pr.timeout_seconds
    FROM models m
    JOIN model_versions mv ON mv.model_id = m.id
    JOIN provider_routes pr ON pr.model_version_id = mv.id
    WHERE pr.provider_id = 'google' ORDER BY m.id`;
console.log(`Switched ${routes.length} google route(s) to interactive.`);
for (const s of state) console.log(`  ${s.id}: mode=${s.mode} timeout=${s.timeout_seconds}s`);
process.exit(0);
