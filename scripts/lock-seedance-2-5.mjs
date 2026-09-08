// One-off: lock Seedance 2.5 for everyone. Drops it from org defaults and
// revokes every live project grant and user ALLOW override, so effectiveAccess
// falls through to deny_default for all users and the picker shows it locked.
// Deny overrides are left alone. Idempotent — safe to re-run.
// Run:  node --env-file=.env.local scripts/lock-seedance-2-5.mjs

import { getDb } from '../lib/db/neon.js';

const ALIAS = 'seedance-2.5';

const sql = await getDb();
if (!sql) { console.error('No database — set DATABASE_URL.'); process.exit(1); }

const [model] = await sql`SELECT id, is_default FROM models WHERE id = ${ALIAS}`;
if (!model) { console.error(`${ALIAS} not in the models catalog — nothing to lock.`); process.exit(1); }

const undefaulted = await sql`UPDATE models SET is_default = false
    WHERE id = ${ALIAS} AND is_default = true RETURNING id`;
const grants = await sql`UPDATE project_model_grants SET revoked_at = now()
    WHERE model_id = ${ALIAS} AND revoked_at IS NULL RETURNING project_id`;
const overrides = await sql`UPDATE user_model_overrides SET revoked_at = now()
    WHERE model_id = ${ALIAS} AND effect = 'allow' AND revoked_at IS NULL
    RETURNING user_id, project_id`;

console.log(`org default removed: ${undefaulted.length > 0 ? 'yes' : 'already off'}`);
console.log(`project grants revoked: ${grants.length}`);
console.log(`user allow overrides revoked: ${overrides.length}`);

const [left] = await sql`SELECT
    (SELECT count(*) FROM project_model_grants WHERE model_id = ${ALIAS} AND revoked_at IS NULL) AS grants,
    (SELECT count(*) FROM user_model_overrides WHERE model_id = ${ALIAS} AND effect = 'allow' AND revoked_at IS NULL) AS allows,
    (SELECT is_default FROM models WHERE id = ${ALIAS}) AS is_default`;
console.log(`remaining access paths — default: ${left.is_default}, grants: ${left.grants}, allows: ${left.allows}`);
process.exit(left.is_default || left.grants > 0 || left.allows > 0 ? 1 : 0);
