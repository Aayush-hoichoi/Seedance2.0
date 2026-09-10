// One-off: register ChatGPT Image 2.5 (OpenAI /v1/images, direct) on an
// existing DB. seedGateway() only INSERTs models that do not exist yet and only
// runs on a fresh getDb(), so a catalog entry added in code never reaches a
// database that has already been seeded — this script is how it gets there.
// Idempotent (mirrors seedGateway), safe to re-run. is_default = false: it is
// permission-gated like every other premium tier.
// Run:  node --env-file=.env.local scripts/insert-chatgpt-image-2-5.mjs

import { getDb } from '../lib/db/neon.js';

// Flare = fast everyday tier; set OPENAI_IMAGE_MODEL_ID=gpt-image-2.5-sunburst
// for the premium-edit tier instead.
const PROVIDER_MODEL = process.env.OPENAI_IMAGE_MODEL_ID || 'gpt-image-2.5-flare';

const sql = await getDb();
if (!sql) { console.error('No database — set DATABASE_URL.'); process.exit(1); }

// A briefly-registered 'gpt-image-1' model (never granted, never ran a job)
// predated this entry — retire it so the console doesn't list a dead row.
await sql`DELETE FROM provider_routes WHERE model_version_id IN (SELECT id FROM model_versions WHERE model_id = 'gpt-image-1')`;
await sql`UPDATE models SET current_version_id = NULL WHERE id = 'gpt-image-1'`;
await sql`DELETE FROM model_versions WHERE model_id = 'gpt-image-1'`;
await sql`DELETE FROM models WHERE id = 'gpt-image-1'`;

await sql`INSERT INTO providers (id, display_name) VALUES ('openai', 'OpenAI') ON CONFLICT DO NOTHING`;

await sql`INSERT INTO models (id, display_name, category, is_default, active)
    VALUES ('chatgpt-image-2.5', 'ChatGPT Image 2.5', 'image', false, true)
    ON CONFLICT DO NOTHING`;
const [version] = await sql`INSERT INTO model_versions (model_id, version_tag, kind, caps)
    VALUES ('chatgpt-image-2.5', ${PROVIDER_MODEL}, 'chatgpt_image_2_5', '{}')
    ON CONFLICT (model_id, version_tag) DO UPDATE SET kind = EXCLUDED.kind
    RETURNING id`;
await sql`UPDATE models SET current_version_id = ${version.id}
    WHERE id = 'chatgpt-image-2.5' AND current_version_id IS NULL`;
await sql`INSERT INTO provider_routes
    (model_version_id, provider_id, provider_model_id, priority, status, mode, timeout_seconds)
    VALUES (${version.id}, 'openai', ${PROVIDER_MODEL}, 1, 'active', 'interactive', NULL)
    ON CONFLICT (model_version_id, provider_id) DO NOTHING`;

const [state] = await sql`SELECT m.id, m.is_default, m.active, mv.version_tag, mv.kind,
        pr.provider_id, pr.provider_model_id, pr.status, pr.mode, pr.timeout_seconds
    FROM models m
    JOIN model_versions mv ON mv.id = m.current_version_id
    JOIN provider_routes pr ON pr.model_version_id = mv.id
    WHERE m.id = 'chatgpt-image-2.5'`;
console.log('chatgpt-image-2.5 ->', JSON.stringify(state));
console.log('OPENAI_API_KEY from the env is used automatically (or store a key: console → Keys, provider "openai").');
console.log('Next: grant the model to a project — it is gated, so nobody has it yet.');
process.exit(0);
