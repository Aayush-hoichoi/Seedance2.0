// Server-only. Neon Postgres over HTTP (@neondatabase/serverless) — used to
// persist the prompt pair (user's raw prompt + GPT-4o-generated brief) per
// ModelArk task id, so any browser can recover both for comparison.
// NEVER import into client code — it reads DATABASE_URL.

import { neon } from '@neondatabase/serverless';

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
        )`.catch((e) => {
            tableReady = null; // retry on the next request instead of caching the failure
            throw e;
        });
    }
    await tableReady;
    return sql;
}
