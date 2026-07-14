// One-time, idempotent migration into the Model Gateway schema.
// Usage:  DATABASE_URL=... node scripts/migrate-gateway.mjs
//
// Steps (design §10): create the "Default" project, enroll every existing user,
// convert approved model_access_requests into user ALLOW overrides, and backfill
// usage_events history into jobs + billing_events settlements. Single-tenant —
// no organization layer. Safe to re-run: guarded by gateway_state.

import { neon } from '@neondatabase/serverless';
import { GATEWAY_DDL, SCHEMA_VERSION } from '../lib/db/schema.mjs';
import { seedGateway } from '../lib/db/seeds.mjs';

const DATABASE_URL = process.env.DATABASE_URL?.trim();
if (!DATABASE_URL) { console.error('DATABASE_URL is required.'); process.exit(1); }

const sql = neon(DATABASE_URL);

async function main() {
    for (const ddl of GATEWAY_DDL) await sql.query(ddl);
    await seedGateway(sql);
    await sql`INSERT INTO gateway_state (key, value, updated_at) VALUES ('schema.version', ${JSON.stringify({ v: SCHEMA_VERSION })}, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;

    const [done] = await sql`SELECT value FROM gateway_state WHERE key = 'migration.v1'`;
    if (done?.value?.completed) {
        console.log('migration.v1 already completed — nothing to do.');
        return;
    }

    // 1. Default project
    const [project] = await sql`INSERT INTO projects (name, created_by)
        VALUES ('Default', 'migration')
        ON CONFLICT (name) DO UPDATE SET archived_at = NULL
        RETURNING id`;
    console.log(`project Default #${project.id}`);

    // 2. Enroll all live users (admins keep an admin project role)
    const users = await sql`SELECT id, role FROM users WHERE deleted_at IS NULL`;
    for (const u of users) {
        const role = u.role === 'admin' ? 'admin' : 'member';
        await sql`INSERT INTO project_memberships (project_id, user_id, role, added_by)
            VALUES (${project.id}, ${u.id}, ${role}, 'migration')
            ON CONFLICT (project_id, user_id) DO NOTHING`;
    }
    console.log(`enrolled ${users.length} users`);

    // 3. Approved access requests → user ALLOW overrides.
    //    Requests store the provider model id; map it to the alias via versions.
    const approved = await sql`SELECT r.user_id, v.model_id
        FROM model_access_requests r
        JOIN model_versions v ON v.version_tag = r.model_id
        WHERE r.status = 'approved'`;
    for (const row of approved) {
        await sql`INSERT INTO user_model_overrides (project_id, user_id, model_id, effect, created_by)
            VALUES (${project.id}, ${row.user_id}, ${row.model_id}, 'allow', 'migration')
            ON CONFLICT (project_id, user_id, model_id) DO NOTHING`;
    }
    console.log(`converted ${approved.length} approvals to ALLOW overrides`);

    // 4. usage_events history → legacy jobs + settlement/failure billing events.
    const events = await sql`SELECT * FROM usage_events ORDER BY id`;
    let migrated = 0;
    for (const e of events) {
        const [existing] = e.task_id
            ? await sql`SELECT id FROM jobs WHERE provider_task_id = ${e.task_id}`
            : [null];
        if (existing) continue;
        const status = e.status === 'failed' ? 'failed' : (e.cost_usd != null || e.status === 'succeeded') ? 'succeeded' : 'failed';
        const alias = (await sql`SELECT model_id FROM model_versions WHERE version_tag = ${e.model_id}`)[0]?.model_id || e.model_id;
        const [job] = await sql`INSERT INTO jobs
            (project_id, user_id, model_id, priority, status, attempt, request_body,
             provider_task_id, provider_id, created_at, started_at, finished_at)
            VALUES (${project.id}, ${e.user_id}, ${alias}, 'interactive', ${status}, 1,
                    ${JSON.stringify({ resolution: e.resolution, duration: e.duration, ratio: e.ratio, mode: e.mode, has_video_input: e.has_video_input, legacy_usage_event: e.id })},
                    ${e.task_id}, 'byteplus', ${e.created_at}, ${e.created_at}, ${e.finalized_at || e.created_at})
            RETURNING id`;
        await sql`INSERT INTO billing_events
            (event_type, generation_id, project_id, user_id, model_id, provider_id,
             units, est_cost_usd, cost_usd, pricing_snapshot, created_at)
            VALUES (${status === 'failed' ? 'failure' : 'settlement'}, ${job.id}, ${project.id},
                    ${e.user_id}, ${alias}, 'byteplus',
                    ${JSON.stringify({ video_seconds: e.duration, completion_tokens: e.completion_tokens == null ? null : Number(e.completion_tokens) })},
                    ${e.est_cost_usd}, ${e.cost_usd}, ${JSON.stringify({ legacy: true })},
                    ${e.finalized_at || e.created_at})`;
        migrated += 1;
    }
    await sql`UPDATE usage_events SET project_id = ${project.id} WHERE project_id IS NULL`;
    console.log(`backfilled ${migrated} usage events into jobs + billing_events`);

    await sql`INSERT INTO gateway_state (key, value) VALUES ('migration.v1', ${JSON.stringify({ completed: true, project: project.id })})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    console.log('migration.v1 complete.');
}

main().catch((e) => { console.error(e); process.exit(1); });
