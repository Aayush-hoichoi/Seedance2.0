// Pure data: every Model Gateway DDL statement, executed in order (once per
// process) by getDb() in lib/db/neon.js. All statements are idempotent.
// Design: docs/superpowers/specs/2026-07-11-model-gateway-design.md §1.

// Bump whenever GATEWAY_DDL changes: getDb() skips the whole chain when the
// stored version matches, keeping cold starts cheap.
export const SCHEMA_VERSION = 12;

export const GATEWAY_DDL = [
    // v1→v2: usage_rollups_daily gained provider_id in its primary key
    // (provider attribution must survive failover). Derived data — safe to drop.
    `DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'usage_rollups_daily')
           AND NOT EXISTS (SELECT 1 FROM information_schema.key_column_usage
                WHERE table_name = 'usage_rollups_daily' AND constraint_name = 'usage_rollups_daily_pkey'
                  AND column_name = 'provider_id') THEN
            DROP TABLE IF EXISTS usage_rollups_daily;
        END IF;
    END $$`,
    // Projects & roles -----------------------------------------------------
    // Single-tenant: projects are the top scope, no organization layer.
    `CREATE TABLE IF NOT EXISTS projects (
        id serial PRIMARY KEY,
        name text NOT NULL,
        paused boolean NOT NULL DEFAULT false,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        archived_at timestamptz,
        UNIQUE (name)
    )`,
    `CREATE TABLE IF NOT EXISTS project_memberships (
        project_id integer NOT NULL,
        user_id text NOT NULL,
        role text NOT NULL DEFAULT 'member',
        added_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS roles (
        id text PRIMARY KEY,
        description text
    )`,
    `CREATE TABLE IF NOT EXISTS permissions (
        id text PRIMARY KEY,
        description text
    )`,
    `CREATE TABLE IF NOT EXISTS role_permissions (
        role_id text NOT NULL,
        permission_id text NOT NULL,
        PRIMARY KEY (role_id, permission_id)
    )`,

    // Model catalog / providers / routing -----------------------------------
    `CREATE TABLE IF NOT EXISTS models (
        id text PRIMARY KEY,
        display_name text NOT NULL,
        category text NOT NULL,
        is_default boolean NOT NULL DEFAULT false,
        active boolean NOT NULL DEFAULT true,
        current_version_id integer
    )`,
    `CREATE TABLE IF NOT EXISTS model_versions (
        id serial PRIMARY KEY,
        model_id text NOT NULL,
        version_tag text NOT NULL,
        kind text NOT NULL,
        caps jsonb,
        UNIQUE (model_id, version_tag)
    )`,
    `CREATE TABLE IF NOT EXISTS providers (
        id text PRIMARY KEY,
        display_name text
    )`,
    `CREATE TABLE IF NOT EXISTS provider_routes (
        id serial PRIMARY KEY,
        model_version_id integer NOT NULL,
        provider_id text NOT NULL,
        provider_model_id text NOT NULL,
        priority integer NOT NULL DEFAULT 1,
        status text NOT NULL DEFAULT 'active',
        mode text NOT NULL DEFAULT 'interactive',
        timeout_seconds integer,
        UNIQUE (model_version_id, provider_id)
    )`,
    `CREATE TABLE IF NOT EXISTS api_keys (
        id serial PRIMARY KEY,
        provider_id text NOT NULL,
        scope_project_id integer,
        ciphertext text NOT NULL,
        label text,
        status text NOT NULL DEFAULT 'active',
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now()
    )`,

    // Access grants ----------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS project_model_grants (
        id serial PRIMARY KEY,
        project_id integer NOT NULL,
        model_id text NOT NULL,
        valid_from timestamptz,
        valid_until timestamptz,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        revoked_at timestamptz,
        UNIQUE (project_id, model_id)
    )`,
    `CREATE TABLE IF NOT EXISTS user_model_overrides (
        id serial PRIMARY KEY,
        project_id integer NOT NULL,
        user_id text NOT NULL,
        model_id text NOT NULL,
        effect text NOT NULL,
        max_resolution text,
        valid_from timestamptz,
        valid_until timestamptz,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        revoked_at timestamptz
    )`,

    // Quotas & budgets ---------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS quotas (
        id serial PRIMARY KEY,
        project_id integer,
        user_id text,
        model_id text,
        type text NOT NULL,
        "window" text NOT NULL,
        hard_limit numeric NOT NULL,
        policy text NOT NULL DEFAULT 'hard',
        soft_overage_pct integer NOT NULL DEFAULT 5,
        alert_thresholds integer[] NOT NULL DEFAULT '{80,90,100}',
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
    )`,
    `CREATE TABLE IF NOT EXISTS quota_alerts_sent (
        quota_id integer NOT NULL,
        window_start date NOT NULL,
        threshold integer NOT NULL,
        sent_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (quota_id, window_start, threshold)
    )`,
    // v8→v9: optional model scope enables model-wide and intersections such as
    // per-project/per-user/per-model budgets. NULL preserves existing behavior.
    `ALTER TABLE quotas ADD COLUMN IF NOT EXISTS model_id text`,

    // Billing — append-only ------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS billing_events (
        id serial PRIMARY KEY,
        event_type text NOT NULL,
        generation_id integer NOT NULL,
        project_id integer NOT NULL,
        user_id text NOT NULL,
        model_id text NOT NULL,
        model_version_id integer,
        provider_id text,
        api_key_id integer,
        units jsonb,
        est_cost_usd numeric(10,4),
        cost_usd numeric(10,4),
        pricing_snapshot jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
    )`,

    // Job queue --------------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS jobs (
        id serial PRIMARY KEY,
        project_id integer NOT NULL,
        user_id text NOT NULL,
        model_id text NOT NULL,
        model_version_id integer,
        priority text NOT NULL DEFAULT 'interactive',
        status text NOT NULL DEFAULT 'queued',
        attempt integer NOT NULL DEFAULT 0,
        request_body jsonb NOT NULL,
        provider_task_id text,
        provider_id text,
        batch_job_name text,
        batch_index integer,
        result jsonb,
        error jsonb,
        run_after timestamptz,
        timeout_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz,
        finished_at timestamptz
    )`,

    // Events outbox for SSE ----------------------------------------------------
    `CREATE TABLE IF NOT EXISTS events (
        id serial PRIMARY KEY,
        project_id integer,
        user_id text,
        type text NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
    )`,

    // v8→v9: durable per-user engagement log — append-only. Every like/unlike
    // and every download becomes one row, keyed by the generation's task_id
    // (the same spine gallery_generations uses). This is what turns "download +
    // like" into per-user, timestamped, countable signal for the training
    // dataset (dataset_samples view below); the seedance_prompts.liked boolean
    // stays as the denormalized current-state for the gallery heart.
    `CREATE TABLE IF NOT EXISTS generation_events (
        id serial PRIMARY KEY,
        task_id text NOT NULL,
        user_id text,
        project_id integer,
        event_type text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
    )`,

    // Audit — insert-only --------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS audit_log (
        id serial PRIMARY KEY,
        actor_id text NOT NULL,
        actor_email text,
        action text NOT NULL,
        target_type text,
        target_id text,
        before jsonb,
        after jsonb,
        reason text,
        ip text,
        created_at timestamptz NOT NULL DEFAULT now()
    )`,

    // v9→v10: one active quota per exact scope. Older builds allowed duplicate
    // rows, and every duplicate was enforced independently. Preserve the
    // effective (strictest) ceiling by keeping the row with the lowest policy-
    // adjusted cap, then soft-delete the redundant rows before adding the
    // partial unique index. COALESCE makes NULL scope dimensions compare equal.
    `DO $quota_scope_migration$
    BEGIN
        -- Block old and new app instances from inserting between cleanup and
        -- index creation during a rolling deployment.
        LOCK TABLE quotas IN SHARE ROW EXCLUSIVE MODE;

        WITH ranked_active_quotas AS (
            SELECT id,
                   row_number() OVER (
                       PARTITION BY COALESCE(project_id, -1), COALESCE(user_id, ''),
                                    COALESCE(model_id, ''), type, "window"
                       ORDER BY hard_limit * CASE
                           WHEN policy = 'soft' THEN 1 + soft_overage_pct::numeric / 100
                           ELSE 1
                       END ASC,
                       created_at DESC,
                       id DESC
                   ) AS duplicate_rank
            FROM quotas
            WHERE deleted_at IS NULL
        )
        UPDATE quotas q
           SET deleted_at = now()
          FROM ranked_active_quotas ranked
         WHERE q.id = ranked.id
           AND ranked.duplicate_rank > 1;

        IF to_regclass('quotas_unique_active_scope') IS NULL THEN
            EXECUTE 'CREATE UNIQUE INDEX quotas_unique_active_scope
                ON quotas (
                    COALESCE(project_id, -1),
                    COALESCE(user_id, ''''),
                    COALESCE(model_id, ''''),
                    type,
                    "window"
                )
                WHERE deleted_at IS NULL';
        END IF;
    END;
    $quota_scope_migration$`,

    // Rollups ---------------------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS usage_rollups_daily (
        day date NOT NULL,
        project_id integer NOT NULL,
        user_id text NOT NULL,
        model_id text NOT NULL,
        provider_id text NOT NULL DEFAULT 'unknown',
        generations integer NOT NULL DEFAULT 0,
        failures integer NOT NULL DEFAULT 0,
        video_seconds numeric NOT NULL DEFAULT 0,
        images integer NOT NULL DEFAULT 0,
        cost_usd numeric(12,4) NOT NULL DEFAULT 0,
        PRIMARY KEY (day, project_id, user_id, model_id, provider_id)
    )`,

    // Tiny shared state (sweep guard etc.) ------------------------------------------
    `CREATE TABLE IF NOT EXISTS gateway_state (
        key text PRIMARY KEY,
        value jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
    )`,

    // usage_events is frozen (kept read-only for safety during migration) but
    // gains a project_id column so pre-migration rows stay queryable.
    `ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS project_id integer`,

    // v5→v6: an allow override can cap the resolution tier ('4k', '2K', …);
    // NULL = no cap. Higher tiers imply lower ones (ladder-index comparison,
    // lib/seedance/constants.js resolutionWithinTier). Enforced at submit
    // (videoCreate/enqueue); pre-existing tables get the column via this ALTER.
    `ALTER TABLE user_model_overrides ADD COLUMN IF NOT EXISTS max_resolution text`,

    // v6→v7: platform quality policy — every PRE-EXISTING grant is capped at
    // the default tier (2K images / 1080p video); 4K is request-only from here
    // on. Data-only backfill: rows an admin already stamped with a tier keep
    // it, only NULL (legacy, pre-policy) caps are filled. New approvals always
    // carry the admin's chosen tier, so NULLs don't reappear.
    `UPDATE user_model_overrides o
        SET max_resolution = CASE m.category WHEN 'image' THEN '2K' ELSE '1080p' END
        FROM models m
        WHERE m.id = o.model_id AND o.effect = 'allow' AND o.max_resolution IS NULL`,
    // Mirror onto the request ledger (video rows key by provider version tag,
    // image rows by the model alias — resolve both) so the upgrade-request
    // decision sees the same cap the gateway enforces.
    `UPDATE model_access_requests r
        SET max_resolution = CASE m.category WHEN 'image' THEN '2K' ELSE '1080p' END
        FROM models m
        LEFT JOIN model_versions v ON v.model_id = m.id
        WHERE (m.id = r.model_id OR v.version_tag = r.model_id)
          AND r.status = 'approved' AND r.max_resolution IS NULL`,

    // v7→v8: members can ask an admin to CREATE a project (name + note).
    // Approval (Slack card or console) creates the project and adds the
    // requester to it; project_id records what got created. One-shot rows —
    // pending → approved/denied, a new ask is a new row.
    `CREATE TABLE IF NOT EXISTS project_requests (
        id serial PRIMARY KEY,
        user_id text NOT NULL,
        user_email text,
        name text NOT NULL,
        note text,
        status text NOT NULL DEFAULT 'pending',
        project_id integer,
        decided_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        decided_at timestamptz
    )`,

    // v10→v11: the override scope constraint. Production had already been
    // hand-migrated from the plain UNIQUE (project_id, user_id, model_id) to a
    // source_request_id column plus two PARTIAL unique indexes, and none of it
    // was declared here — so `ON CONFLICT (project_id, user_id, model_id)` in
    // lib/access/gatewaySync.mjs could not infer an arbiter and every approval
    // threw. The approve route swallowed it, so the request row flipped to
    // approved while the override the gateway actually enforces went untouched
    // — an access grant the console showed and the user could not use. These
    // statements make the declared schema match, so a fresh database and
    // production agree. uuid (not integer) mirrors the column production got.
    `ALTER TABLE user_model_overrides ADD COLUMN IF NOT EXISTS source_request_id uuid`,
    `ALTER TABLE user_model_overrides DROP CONSTRAINT IF EXISTS user_model_overrides_project_id_user_id_model_id_key`,
    // Split by provenance: at most one hand-made override per scope, and at
    // most one per scope per originating access request. gatewaySync leaves
    // source_request_id NULL, so its upsert arbitrates on the manual index.
    `CREATE UNIQUE INDEX IF NOT EXISTS user_model_overrides_manual_scope_uidx
        ON user_model_overrides (project_id, user_id, model_id) WHERE source_request_id IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS user_model_overrides_request_scope_uidx
        ON user_model_overrides (project_id, user_id, model_id, source_request_id) WHERE source_request_id IS NOT NULL`,

    // v11→v12: Microsoft Teams budget-approval cards ----------------------------------
    // A card is a PROJECTION of audit_log, never a second copy of the decision.
    // This table exists only so a card already delivered can be UPDATED later:
    // Teams has no subscription model, so editing a message requires the exact
    // conversation + activity id it was posted with, and Microsoft will not hand
    // those back after the fact. Recorded at send time or the card is frozen
    // forever. Nothing here is consulted when deciding a request.
    `CREATE TABLE IF NOT EXISTS teams_budget_cards (
        id serial PRIMARY KEY,
        request_id text NOT NULL,
        aad_object_id text NOT NULL,
        conversation_id text NOT NULL,
        activity_id text NOT NULL,
        state text NOT NULL DEFAULT 'pending',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    // One card per admin per request: a retried send updates the row rather than
    // orphaning the activity id of the card it replaced.
    `CREATE UNIQUE INDEX IF NOT EXISTS teams_budget_cards_request_admin_uidx
        ON teams_budget_cards (request_id, aad_object_id)`,
    // Inbound identity. An approval must resolve to a REAL app user because
    // decideBudgetRequest writes actor_id/actor_email into the audit row, and a
    // Teams decision has to be indistinguishable from a console one. Matched by
    // exact AAD object id only — this tenant spans several verified domains, so
    // name or email matching could authorise the wrong person.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS teams_aad_object_id text`,
    `CREATE UNIQUE INDEX IF NOT EXISTS users_teams_aad_uidx
        ON users (teams_aad_object_id) WHERE teams_aad_object_id IS NOT NULL`,

    // Indexes on the reporting/queue dimensions ---------------------------------------
    `CREATE INDEX IF NOT EXISTS billing_events_created ON billing_events (created_at)`,
    `CREATE INDEX IF NOT EXISTS billing_events_project_user ON billing_events (project_id, user_id)`,
    `CREATE INDEX IF NOT EXISTS billing_events_generation ON billing_events (generation_id)`,
    `CREATE INDEX IF NOT EXISTS billing_events_model ON billing_events (model_id)`,
    `CREATE INDEX IF NOT EXISTS quotas_active_scope ON quotas (project_id, user_id, model_id) WHERE deleted_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS jobs_status_priority ON jobs (status, priority, created_at)`,
    `CREATE INDEX IF NOT EXISTS jobs_project_status ON jobs (project_id, status)`,
    `CREATE INDEX IF NOT EXISTS overrides_user_project ON user_model_overrides (user_id, project_id)`,
    `CREATE INDEX IF NOT EXISTS audit_log_created ON audit_log (created_at)`,

    // v2→v3: the gallery/history/ownership reads used to come from usage_events,
    // but the gateway writes video generations to `jobs` and NEVER back-fills
    // usage_events — so every gateway-era generation was invisible in the
    // community gallery and per-user history (a user who joined after the
    // migration showed 0 videos). This view is the single normalized source the
    // read side now points at: it projects `jobs` into the usage_events-shaped
    // columns the gallery expects. `model_id` maps back to the ModelArk version
    // tag (via model_versions) so name lookup still resolves. jobs is a complete
    // superset of usage_events (verified: 0 usage rows absent from jobs).
    //
    // Both media types: video jobs carry a provider_task_id (archived under
    // videos/<taskId>.mp4); image jobs settle synchronously with NO task id, so
    // they're keyed by 'job:<id>' and surface the first stored image key
    // (images/job-<id>-0.<ext>) + the prompt straight off the request body
    // (images write no seedance_prompts row). New columns are appended so
    // CREATE OR REPLACE stays valid.
    `CREATE OR REPLACE VIEW gallery_generations AS
        SELECT
            coalesce(j.provider_task_id, 'job:' || j.id)                          AS task_id,
            j.user_id,
            u.email                                                               AS user_email,
            coalesce(mv.version_tag, j.model_id)                                  AS model_id,
            coalesce(j.request_body->'options'->>'resolution',
                     j.request_body->'options'->>'imageSize')                    AS resolution,
            (j.request_body->'options'->>'duration')::int                        AS duration,
            coalesce(j.request_body->'options'->>'ratio',
                     j.request_body->'options'->>'aspectRatio')                  AS ratio,
            j.request_body->'options'->>'mode'                                   AS mode,
            j.status,
            coalesce((j.request_body->'options'->>'has_video_input')::boolean, false) AS has_video_input,
            coalesce(j.started_at, j.created_at)                                  AS created_at,
            coalesce(j.request_body->>'category', 'video')                        AS category,
            j.result->'images'->0->>'key'                                        AS image_key,
            j.request_body->>'prompt'                                            AS image_prompt,
            -- Present once the video is durably archived to TOS (settleSuccess
            -- writes it). NULL for legacy/browser-only archives — the dataset
            -- treats those as unconfirmed. Appended last so CREATE OR REPLACE
            -- stays valid (existing columns must keep their position).
            j.result->>'video_key'                                              AS video_key
        FROM jobs j
        LEFT JOIN users u ON u.id = j.user_id
        LEFT JOIN model_versions mv ON mv.id = j.model_version_id
        WHERE j.provider_task_id IS NOT NULL
           OR (coalesce(j.request_body->>'category', 'video') = 'image'
               AND j.result->'images'->0->>'key' IS NOT NULL)`,

    // Engagement log index — task_id joins to gallery_generations; the partial
    // by (user_id, event_type) serves both per-user history and the aggregates.
    `CREATE INDEX IF NOT EXISTS generation_events_task ON generation_events (task_id)`,
    `CREATE INDEX IF NOT EXISTS generation_events_user_type ON generation_events (user_id, event_type)`,

    // v8→v9: the training dataset. One row per succeeded, non-binned generation:
    // the INPUT (prompt + reference assets, each ref carrying a durable
    // uploads/<…> tosKey) mapped to the OUTPUT object key, plus the engagement
    // signal (download total + distinct likers) from generation_events.
    //   • output_key  — videos/<taskId>.mp4 (prefers the archived video_key) or
    //                   the stored image key.
    //   • output_confirmed — true once the output object is known to exist in
    //     TOS (image key stored, or video archived server-side). Going forward
    //     every row is confirmed; pre-P1a video rows may be false (provider URL
    //     expired) and are best-effort only.
    // ponytail: likes = distinct users with a 'like' event, ignoring later
    // unlike churn (unlikes are still logged, so this can be refined to net-state
    // later if it matters). Downloads = every download, repeats included.
    `CREATE OR REPLACE VIEW dataset_samples AS
        SELECT
            g.task_id,
            g.user_id,
            g.user_email,
            g.model_id,
            g.category,
            g.resolution,
            g.duration,
            g.ratio,
            g.mode,
            g.created_at,
            coalesce(p.generated_prompt, p.user_prompt, g.image_prompt)          AS prompt,
            p.user_prompt,
            p.generated_prompt,
            p.style,
            p.refs                                                               AS input_refs,
            CASE WHEN g.category = 'image' THEN g.image_key
                 ELSE coalesce(g.video_key, 'videos/' || regexp_replace(g.task_id, '[^\\w.-]+', '_', 'g') || '.mp4')
            END                                                                  AS output_key,
            CASE WHEN g.category = 'image' THEN g.image_key IS NOT NULL
                 ELSE g.video_key IS NOT NULL
            END                                                                  AS output_confirmed,
            coalesce(ev.downloads, 0)                                            AS downloads,
            coalesce(ev.likes, 0)                                                AS likes
        FROM gallery_generations g
        LEFT JOIN seedance_prompts p ON p.task_id = g.task_id
        LEFT JOIN (
            SELECT task_id,
                count(*) FILTER (WHERE event_type = 'download')          AS downloads,
                count(DISTINCT user_id) FILTER (WHERE event_type = 'like') AS likes
            FROM generation_events GROUP BY task_id
        ) ev ON ev.task_id = g.task_id
        WHERE g.status = 'succeeded' AND coalesce(p.deleted, false) = false`,
];
