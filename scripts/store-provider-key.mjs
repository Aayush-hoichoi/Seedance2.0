// Store a provider API key in the DB, encrypted — the same insert-with-rotation
// /api/admin/keys POST does, for when using the API is awkward (there is no
// console Keys page yet). The key is read from STDIN so it never lands in shell
// history or ps output.
// Run:  node --env-file=.env.local scripts/store-provider-key.mjs <provider> [label]
// e.g.  node --env-file=.env.local scripts/store-provider-key.mjs openai "images key"
//       (then paste the key and press Enter)

import { getDb } from '../lib/db/neon.js';
import { encryptSecret, keyLast4 } from '../lib/gateway/keybox.mjs';

const [providerId, label = null] = process.argv.slice(2);
if (!providerId) { console.error('Usage: store-provider-key.mjs <provider> [label]'); process.exit(1); }
if (!process.env.KEY_ENCRYPTION_KEY) { console.error('Set KEY_ENCRYPTION_KEY first.'); process.exit(1); }

const sql = await getDb();
if (!sql) { console.error('No database — set DATABASE_URL.'); process.exit(1); }
const [provider] = await sql`SELECT id FROM providers WHERE id = ${providerId}`;
if (!provider) { console.error(`Unknown provider "${providerId}" — seed it first.`); process.exit(1); }

process.stderr.write(`Paste the ${providerId} API key and press Enter: `);
let key = '';
for await (const chunk of process.stdin) { key += chunk; if (key.includes('\n')) break; }
key = key.trim();
if (!key) { console.error('No key given.'); process.exit(1); }

// Rotation, same as the API route: previous workspace-wide active keys retire.
await sql`UPDATE api_keys SET status = 'retiring'
    WHERE provider_id = ${providerId} AND status = 'active' AND scope_project_id IS NULL`;
const [row] = await sql`INSERT INTO api_keys (provider_id, scope_project_id, ciphertext, label, created_by)
    VALUES (${providerId}, NULL, ${encryptSecret(key)}, ${label}, NULL)
    RETURNING id, provider_id, label, status`;
console.log(`Stored key ...${keyLast4(key)} ->`, JSON.stringify(row));
process.exit(0);
