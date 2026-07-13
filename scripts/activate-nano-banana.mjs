// One-off: activate the Nano Banana (Google Gemini) image routes on an EXISTING
// database. The seed inserts provider_routes with ON CONFLICT DO NOTHING, so a
// DB seeded while the routes were 'disabled' keeps them disabled — this flips
// them to 'active' and marks the models default (so effectiveAccess allows them
// org-wide). Idempotent. Run:  node --env-file=.env.local scripts/activate-nano-banana.mjs
// Note: generation still needs GOOGLE_API_KEY configured for the 'google' provider.

import { getDb } from '../lib/db/neon.js';

const sql = await getDb();
if (!sql) {
    console.error('No database — set DATABASE_URL (e.g. node --env-file=.env.local …).');
    process.exit(1);
}

const routes = await sql`
    UPDATE provider_routes SET status = 'active'
    WHERE provider_id = 'google' AND status <> 'active'
    RETURNING model_version_id`;
const models = await sql`
    UPDATE models SET is_default = true
    WHERE id IN ('nano-banana-pro', 'nano-banana-2') AND is_default = false
    RETURNING id`;

console.log(`Activated ${routes.length} google route(s); defaulted ${models.length} model(s).`);
console.log('Nano Banana ready — set GOOGLE_API_KEY to actually generate.');
process.exit(0);
