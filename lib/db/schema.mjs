// Pure data: every Model Gateway DDL statement, executed in order (once per
// process) by getDb() in lib/db/neon.js. All statements are idempotent.
// Design: docs/superpowers/specs/2026-07-11-model-gateway-design.md §1.

// Bump whenever GATEWAY_DDL changes: getDb() skips the whole chain when the
// stored version matches, keeping cold starts cheap.
export const SCHEMA_VERSION = 3;

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
    // Identity mirrors -----------------------------------------------------
    `CREATE TABLE IF NOT EXISTS organizations (
        id text PRIMARY KEY,
        name text,
        slug text,
        created_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
    )`,

    // Projects & roles -----------------------------------------------------
    `CREATE TABLE IF NOT EXISTS projects (
        id serial PRIMARY KEY,
        org_id text NOT NULL,
        name text NOT NULL,
        paused boolean NOT NULL DEFAULT false,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        archived_at timestamptz,
        UNIQUE (org_id, name)
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
        scope_org_id text,
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
        valid_from timestamptz,
        valid_until timestamptz,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        revoked_at timestamptz,
        UNIQUE (project_id, user_id, model_id)
    )`,

    // Quotas & budgets ---------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS quotas (
        id serial PRIMARY KEY,
        org_id text NOT NULL,
        project_id integer,
        user_id text,
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

    // Billing — append-only ------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS billing_events (
        id serial PRIMARY KEY,
        event_type text NOT NULL,
        generation_id integer NOT NULL,
        org_id text NOT NULL,
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
        org_id text NOT NULL,
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
        org_id text NOT NULL,
        project_id integer,
        user_id text,
        type text NOT NULL,
        payload jsonb NOT NULL,
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

    // Rollups ---------------------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS usage_rollups_daily (
        day date NOT NULL,
        org_id text NOT NULL,
        project_id integer NOT NULL,
        user_id text NOT NULL,
        model_id text NOT NULL,
        provider_id text NOT NULL DEFAULT 'unknown',
        generations integer NOT NULL DEFAULT 0,
        failures integer NOT NULL DEFAULT 0,
        video_seconds numeric NOT NULL DEFAULT 0,
        images integer NOT NULL DEFAULT 0,
        cost_usd numeric(12,4) NOT NULL DEFAULT 0,
        PRIMARY KEY (day, org_id, project_id, user_id, model_id, provider_id)
    )`,

    // Tiny shared state (sweep guard etc.) ------------------------------------------
    `CREATE TABLE IF NOT EXISTS gateway_state (
        key text PRIMARY KEY,
        value jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
    )`,

    // usage_events is frozen (kept read-only for safety during migration) but
    // gains attribution columns so pre-migration rows stay queryable.
    `ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS org_id text`,
    `ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS project_id integer`,

    // Indexes on the reporting/queue dimensions ---------------------------------------
    `CREATE INDEX IF NOT EXISTS billing_events_org_created ON billing_events (org_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS billing_events_project_user ON billing_events (project_id, user_id)`,
    `CREATE INDEX IF NOT EXISTS billing_events_generation ON billing_events (generation_id)`,
    `CREATE INDEX IF NOT EXISTS billing_events_model ON billing_events (model_id)`,
    `CREATE INDEX IF NOT EXISTS jobs_status_priority ON jobs (status, priority, created_at)`,
    `CREATE INDEX IF NOT EXISTS jobs_project_status ON jobs (project_id, status)`,
    `CREATE INDEX IF NOT EXISTS events_org_id ON events (org_id, id)`,
    `CREATE INDEX IF NOT EXISTS overrides_user_project ON user_model_overrides (user_id, project_id)`,
    `CREATE INDEX IF NOT EXISTS audit_log_created ON audit_log (created_at)`,

    // v2→v3: the gallery/history/ownership reads used to come from usage_events,
    // but the gateway writes video generations to `jobs` and NEVER back-fills
    // usage_events — so every gateway-era generation was invisible in the
    // community gallery and per-user history (a user who joined after the
    // migration showed 0 videos). This view is the single normalized source the
    // read side now points at: it projects `jobs` into the usage_events-shaped
    // columns the gallery expects. `model_id` maps back to the ModelArk version
    // tag (via model_versions) so name lookup still resolves; video-only to
    // match the gallery's historic semantics. jobs is a complete superset of
    // usage_events (verified: 0 usage rows absent from jobs), so nothing is lost.
    `CREATE OR REPLACE VIEW gallery_generations AS
        SELECT
            j.provider_task_id                                                    AS task_id,
            j.user_id,
            u.email                                                               AS user_email,
            coalesce(mv.version_tag, j.model_id)                                  AS model_id,
            j.request_body->'options'->>'resolution'                             AS resolution,
            (j.request_body->'options'->>'duration')::int                        AS duration,
            j.request_body->'options'->>'ratio'                                  AS ratio,
            j.request_body->'options'->>'mode'                                   AS mode,
            j.status,
            coalesce((j.request_body->'options'->>'has_video_input')::boolean, false) AS has_video_input,
            coalesce(j.started_at, j.created_at)                                  AS created_at
        FROM jobs j
        LEFT JOIN users u ON u.id = j.user_id
        LEFT JOIN model_versions mv ON mv.id = j.model_version_id
        WHERE j.provider_task_id IS NOT NULL
          AND coalesce(j.request_body->>'category', 'video') = 'video'`,
];
