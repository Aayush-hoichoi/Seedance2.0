// One-off: point Seedream 5.0 Pro at the REAL ModelArk model id on an existing
// DB. The catalog was seeded with a placeholder ('seedream-5-0-pro') that ARK
// rejects; the live id is seedream-5-0-260128 (verified against the images/
// generations API). Idempotent. Run:
//   node --env-file=.env.local scripts/wire-seedream.mjs

import { getDb } from '../lib/db/neon.js';

const REAL = process.env.SEEDREAM_MODEL_ID || 'seedream-5-0-260128';
const sql = await getDb();
if (!sql) { console.error('No database — set DATABASE_URL.'); process.exit(1); }

const v = await sql`UPDATE model_versions SET version_tag = ${REAL}
    WHERE model_id = 'seedream-5.0-pro' AND version_tag <> ${REAL} RETURNING id`;
const r = await sql`UPDATE provider_routes SET provider_model_id = ${REAL}, status = 'active'
    WHERE model_version_id IN (SELECT id FROM model_versions WHERE model_id = 'seedream-5.0-pro')
      AND (provider_model_id <> ${REAL} OR status <> 'active') RETURNING id`;

const [state] = await sql`SELECT mv.version_tag, pr.provider_model_id, pr.status, pr.mode
    FROM model_versions mv JOIN provider_routes pr ON pr.model_version_id = mv.id
    WHERE mv.model_id = 'seedream-5.0-pro' LIMIT 1`;
console.log(`Updated ${v.length} version(s), ${r.length} route(s).`);
console.log('seedream-5.0-pro ->', JSON.stringify(state));
process.exit(0);
