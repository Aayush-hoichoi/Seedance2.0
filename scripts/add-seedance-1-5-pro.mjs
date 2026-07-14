// Add Seedance 1.5 Pro to the live catalog as an org-default video model.
// Model id live-validated against ModelArk (submit accepted). Idempotent. Run:
//   node --env-file=.env.local scripts/add-seedance-1-5-pro.mjs

import { getDb } from '../lib/db/neon.js';

const ALIAS = 'seedance-1.5-pro';
const TAG = process.env.NEXT_PUBLIC_SEEDANCE_1_5_PRO_MODEL_ID || 'seedance-1-5-pro-251215';
const KIND = 'pro_1_5';
const CAPS = { supports1080p: true, supports4k: false };

const sql = await getDb();
if (!sql) { console.error('No database — set DATABASE_URL.'); process.exit(1); }

// Model alias (default + active). Force is_default=true even if the row exists.
await sql`INSERT INTO models (id, display_name, category, is_default, active)
    VALUES (${ALIAS}, 'Seedance 1.5 Pro', 'video', true, true)
    ON CONFLICT (id) DO UPDATE SET is_default = true, active = true, display_name = EXCLUDED.display_name`;

const [version] = await sql`INSERT INTO model_versions (model_id, version_tag, kind, caps)
    VALUES (${ALIAS}, ${TAG}, ${KIND}, ${JSON.stringify(CAPS)})
    ON CONFLICT (model_id, version_tag) DO UPDATE SET kind = EXCLUDED.kind, caps = EXCLUDED.caps
    RETURNING id`;

await sql`UPDATE models SET current_version_id = ${version.id} WHERE id = ${ALIAS}`;

await sql`INSERT INTO provider_routes
    (model_version_id, provider_id, provider_model_id, priority, status, mode, timeout_seconds)
    VALUES (${version.id}, 'byteplus', ${TAG}, 1, 'active', 'interactive', NULL)
    ON CONFLICT (model_version_id, provider_id)
    DO UPDATE SET provider_model_id = EXCLUDED.provider_model_id, status = 'active'`;

const [state] = await sql`SELECT m.id, m.is_default, m.active, v.version_tag, v.kind, pr.provider_id, pr.status
    FROM models m JOIN model_versions v ON v.id = m.current_version_id
    JOIN provider_routes pr ON pr.model_version_id = v.id WHERE m.id = ${ALIAS}`;
console.log('Seedance 1.5 Pro wired:', JSON.stringify(state));
console.log(`default video models now: ${(await sql`SELECT id FROM models WHERE is_default = true AND active = true AND category='video'`).map(r=>r.id).join(', ')}`);
process.exit(0);
