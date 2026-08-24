// One-off: register ChatGPT Image 2 (OpenAI GPT Image 2, served by kie.ai) on an
// existing DB. seedGateway() only INSERTs models that do not exist yet and only
// runs on a fresh getDb(), so a catalog entry added in code never reaches a
// database that has already been seeded — this script is how it gets there.
// Idempotent (mirrors seedGateway), safe to re-run. is_default = false: it is
// permission-gated like every other premium tier.
// Run:  node --env-file=.env.local scripts/insert-chatgpt-image-2.mjs

import { getDb } from '../lib/db/neon.js';

// kie's TEXT-TO-IMAGE slug. The adapter swaps in the image-to-image sibling
// (gpt-image-2-image-to-image) when the prompt carries reference images.
const PROVIDER_MODEL = process.env.KIE_GPT_IMAGE_2_MODEL_ID || 'gpt-image-2-text-to-image';
const TIMEOUT_SECONDS = 900; // kie: stop polling after 10–15 min

const sql = await getDb();
if (!sql) { console.error('No database — set DATABASE_URL.'); process.exit(1); }

await sql`INSERT INTO providers (id, display_name) VALUES ('kie', 'kie.ai') ON CONFLICT DO NOTHING`;

await sql`INSERT INTO models (id, display_name, category, is_default, active)
    VALUES ('chatgpt-image-2', 'ChatGPT Image 2', 'image', false, true)
    ON CONFLICT DO NOTHING`;
const [version] = await sql`INSERT INTO model_versions (model_id, version_tag, kind, caps)
    VALUES ('chatgpt-image-2', ${PROVIDER_MODEL}, 'chatgpt_image_2', '{}')
    ON CONFLICT (model_id, version_tag) DO UPDATE SET kind = EXCLUDED.kind
    RETURNING id`;
await sql`UPDATE models SET current_version_id = ${version.id}
    WHERE id = 'chatgpt-image-2' AND current_version_id IS NULL`;
await sql`INSERT INTO provider_routes
    (model_version_id, provider_id, provider_model_id, priority, status, mode, timeout_seconds)
    VALUES (${version.id}, 'kie', ${PROVIDER_MODEL}, 1, 'active', 'interactive', ${TIMEOUT_SECONDS})
    ON CONFLICT (model_version_id, provider_id) DO NOTHING`;

const [state] = await sql`SELECT m.id, m.is_default, m.active, mv.version_tag, mv.kind,
        pr.provider_id, pr.provider_model_id, pr.status, pr.mode, pr.timeout_seconds
    FROM models m
    JOIN model_versions mv ON mv.id = m.current_version_id
    JOIN provider_routes pr ON pr.model_version_id = mv.id
    WHERE m.id = 'chatgpt-image-2'`;
console.log('chatgpt-image-2 ->', JSON.stringify(state));
console.log('Next: store the kie.ai key (console → Keys, provider "kie") or set KIE_API_KEY,');
console.log('then grant the model to a project — it is gated, so nobody has it yet.');
process.exit(0);
