// Server-only. Neon Postgres over HTTP (@neondatabase/serverless) — used to
// persist the prompt pair (user's raw prompt + GPT-4o-generated brief) per
// ModelArk task id, so any browser can recover both for comparison.
// NEVER import into client code — it reads DATABASE_URL.

import { neon } from '@neondatabase/serverless';
import { GATEWAY_DDL, SCHEMA_VERSION } from './schema.mjs';
import { seedGateway } from './seeds.mjs';

// Skip the ~30-statement DDL+seed chain when this database already carries
// the current schema version — cold starts pay one SELECT instead.
async function ensureGatewaySchema(sql) {
    try {
        const [row] = await sql`SELECT value FROM gateway_state WHERE key = 'schema.version'`;
        if (Number(row?.value?.v) === SCHEMA_VERSION) return;
    } catch (e) {
        // Only "relation does not exist" means first boot; anything else is a
        // real DB problem and must surface, not trigger a silent re-migration.
        if (e?.code !== '42P01') throw e;
    }
    for (const ddl of GATEWAY_DDL) await sql.query(ddl);
    await seedGateway(sql);
    await sql`INSERT INTO gateway_state (key, value, updated_at) VALUES ('schema.version', ${JSON.stringify({ v: SCHEMA_VERSION })}, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

let sql = null;
let tableReady = null;

// Returns a ready-to-query client (table guaranteed to exist), or null when
// DATABASE_URL is not configured. Throws if the database is unreachable.
export async function getDb() {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) return null;
    if (!sql) sql = neon(url);
    if (!tableReady) {
        tableReady = sql`CREATE TABLE IF NOT EXISTS seedance_prompts (
            task_id text PRIMARY KEY,
            style text,
            user_prompt text,
            generated_prompt text,
            created_at timestamptz NOT NULL DEFAULT now()
        )`
            // refs: the reference assets (asset:// items) attached to the
            // generation, so any browser can show + reuse them from history.
            .then(() => sql`ALTER TABLE seedance_prompts ADD COLUMN IF NOT EXISTS refs jsonb`)
            // liked: the user's "like" mark on a history item, persisted so it
            // survives cleared localStorage and follows the account everywhere.
            .then(() => sql`ALTER TABLE seedance_prompts ADD COLUMN IF NOT EXISTS liked boolean NOT NULL DEFAULT false`)
            // deleted: the "bin" (soft-delete) flag, persisted so a generation
            // binned in one browser stays hidden in every browser (otherwise the
            // reload server-merge re-adds it for other users).
            .then(() => sql`ALTER TABLE seedance_prompts ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false`)
            // project_id: the gateway project a generation belongs to, so the
            // history/prompt store is attributable + queryable per project.
            .then(() => sql`ALTER TABLE seedance_prompts ADD COLUMN IF NOT EXISTS project_id integer`)
            // Per-user model-access requests/grants (one row per user+model).
            .then(() => sql`CREATE TABLE IF NOT EXISTS model_access_requests (
                id serial PRIMARY KEY,
                user_id text NOT NULL,
                user_email text NOT NULL,
                model_id text NOT NULL,
                status text NOT NULL,
                note text,
                decided_by text,
                created_at timestamptz NOT NULL DEFAULT now(),
                decided_at timestamptz,
                UNIQUE (user_id, model_id)
            )`)
            // expires_at: approvals are time-boxed — an admin sets a deadline
            // when approving; past it the grant no longer unlocks the model
            // (getApprovedModelIds filters it, and the gateway override's
            // valid_until enforces it server-side).
            .then(() => sql`ALTER TABLE model_access_requests ADD COLUMN IF NOT EXISTS expires_at timestamptz`)
            // Canonical mirror of Clerk users, maintained by the Clerk webhook
            // (user.created/updated/deleted). deleted_at soft-deletes so usage
            // history keeps resolving an identity after a Clerk delete.
            .then(() => sql`CREATE TABLE IF NOT EXISTS users (
                id text PRIMARY KEY,
                email text,
                name text,
                role text,
                created_at timestamptz,
                updated_at timestamptz NOT NULL DEFAULT now(),
                deleted_at timestamptz
            )`)
            // Per-generation usage log with real + estimated USD cost.
            .then(() => sql`CREATE TABLE IF NOT EXISTS usage_events (
                id serial PRIMARY KEY,
                user_id text NOT NULL,
                user_email text NOT NULL,
                model_id text NOT NULL,
                resolution text,
                duration integer,
                ratio text,
                mode text,
                has_video_input boolean NOT NULL DEFAULT false,
                task_id text,
                status text NOT NULL DEFAULT 'created',
                completion_tokens bigint,
                est_cost_usd numeric(10,4),
                cost_usd numeric(10,4),
                created_at timestamptz NOT NULL DEFAULT now(),
                finalized_at timestamptz,
                UNIQUE (task_id)
            )`)
            // Model Gateway tables + catalog seeds (idempotent; see lib/db/schema.mjs).
            .then(() => ensureGatewaySchema(sql))
            .catch((e) => {
                tableReady = null; // retry on the next request instead of caching the failure
                throw e;
            });
    }
    await tableReady;
    return sql;
}
