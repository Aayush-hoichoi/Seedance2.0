// One-off: register Cinematic Studio as its own catalog model on an existing DB
// so it's independently grantable (console) / requestable and routable. It uses
// the SAME Gemini Pro provider as nano-banana-pro but is a distinct access
// entity. is_default=false (permission-gated). Idempotent (mirrors seedGateway).
// Run:  node --env-file=.env.local scripts/insert-cinematic-studio.mjs

import { getDb } from '../lib/db/neon.js';

const PROVIDER_MODEL = process.env.NANO_BANANA_PRO_MODEL_ID || 'gemini-3-pro-image-preview';
const sql = await getDb();
if (!sql) { console.error('No database — set DATABASE_URL.'); process.exit(1); }

await sql`INSERT INTO models (id, display_name, category, is_default, active)
    VALUES ('cinematic-studio', 'Cinematic Studio', 'image', false, true)
    ON CONFLICT DO NOTHING`;
const [version] = await sql`INSERT INTO model_versions (model_id, version_tag, kind, caps)
    VALUES ('cinematic-studio', ${PROVIDER_MODEL}, 'nano_banana_pro', '{}')
    ON CONFLICT (model_id, version_tag) DO UPDATE SET kind = EXCLUDED.kind
    RETURNING id`;
await sql`UPDATE models SET current_version_id = ${version.id}
    WHERE id = 'cinematic-studio' AND current_version_id IS NULL`;
await sql`INSERT INTO provider_routes
    (model_version_id, provider_id, provider_model_id, priority, status, mode, timeout_seconds)
    VALUES (${version.id}, 'google', ${PROVIDER_MODEL}, 1, 'active', 'interactive', 300)
    ON CONFLICT (model_version_id, provider_id) DO NOTHING`;

const [state] = await sql`SELECT m.id, m.is_default, m.active, mv.version_tag, pr.provider_id, pr.mode
    FROM models m
    JOIN model_versions mv ON mv.id = m.current_version_id
    JOIN provider_routes pr ON pr.model_version_id = mv.id
    WHERE m.id = 'cinematic-studio'`;
console.log('cinematic-studio ->', JSON.stringify(state));
process.exit(0);
