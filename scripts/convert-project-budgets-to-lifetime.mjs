import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required.');

const sql = neon(databaseUrl);
const migration = `DO $carryover_lifetime_conversion$
DECLARE
    monthly_quota quotas%ROWTYPE;
    lifetime_quota quotas%ROWTYPE;
    last_month_usage numeric;
    current_month_usage numeric;
    lifetime_usage numeric;
    carryover numeric;
    new_hard_limit numeric;
    has_lifetime boolean;
BEGIN
    LOCK TABLE quotas IN SHARE ROW EXCLUSIVE MODE;

    FOR monthly_quota IN SELECT * FROM quotas
        WHERE project_id IS NOT NULL AND "window" = 'monthly' AND deleted_at IS NULL ORDER BY id
    LOOP
        SELECT * INTO lifetime_quota FROM quotas
        WHERE project_id IS NOT DISTINCT FROM monthly_quota.project_id
          AND user_id IS NOT DISTINCT FROM monthly_quota.user_id
          AND model_id IS NOT DISTINCT FROM monthly_quota.model_id
          AND type = monthly_quota.type AND "window" = 'lifetime' AND deleted_at IS NULL FOR UPDATE;
        has_lifetime := FOUND;

        SELECT COALESCE(SUM(CASE monthly_quota.type
            WHEN 'image_count' THEN COALESCE((b.units->>'images')::numeric, 0)
            WHEN 'video_seconds' THEN COALESCE((b.units->>'video_seconds')::numeric, 0)
            WHEN 'request_count' THEN 1::numeric ELSE COALESCE(b.cost_usd, b.est_cost_usd, 0) END), 0)
        INTO last_month_usage FROM billing_events b
        WHERE b.created_at >= date_trunc('month', now()) - interval '1 month' AND b.created_at < date_trunc('month', now())
          AND (monthly_quota.project_id IS NULL OR b.project_id = monthly_quota.project_id)
          AND (monthly_quota.user_id IS NULL OR b.user_id = monthly_quota.user_id)
          AND (monthly_quota.model_id IS NULL OR b.model_id = monthly_quota.model_id)
          AND (b.event_type IN ('settlement', 'failure') OR (b.event_type = 'reservation' AND NOT EXISTS (
              SELECT 1 FROM billing_events done WHERE done.generation_id = b.generation_id
                AND done.event_type IN ('settlement', 'failure', 'release'))));

        SELECT COALESCE(SUM(CASE monthly_quota.type
            WHEN 'image_count' THEN COALESCE((b.units->>'images')::numeric, 0)
            WHEN 'video_seconds' THEN COALESCE((b.units->>'video_seconds')::numeric, 0)
            WHEN 'request_count' THEN 1::numeric ELSE COALESCE(b.cost_usd, b.est_cost_usd, 0) END), 0)
        INTO current_month_usage FROM billing_events b
        WHERE b.created_at >= date_trunc('month', now())
          AND (monthly_quota.project_id IS NULL OR b.project_id = monthly_quota.project_id)
          AND (monthly_quota.user_id IS NULL OR b.user_id = monthly_quota.user_id)
          AND (monthly_quota.model_id IS NULL OR b.model_id = monthly_quota.model_id)
          AND (b.event_type IN ('settlement', 'failure') OR (b.event_type = 'reservation' AND NOT EXISTS (
              SELECT 1 FROM billing_events done WHERE done.generation_id = b.generation_id
                AND done.event_type IN ('settlement', 'failure', 'release'))));

        SELECT COALESCE(SUM(CASE monthly_quota.type
            WHEN 'image_count' THEN COALESCE((b.units->>'images')::numeric, 0)
            WHEN 'video_seconds' THEN COALESCE((b.units->>'video_seconds')::numeric, 0)
            WHEN 'request_count' THEN 1::numeric ELSE COALESCE(b.cost_usd, b.est_cost_usd, 0) END), 0)
        INTO lifetime_usage FROM billing_events b
        WHERE (monthly_quota.project_id IS NULL OR b.project_id = monthly_quota.project_id)
          AND (monthly_quota.user_id IS NULL OR b.user_id = monthly_quota.user_id)
          AND (monthly_quota.model_id IS NULL OR b.model_id = monthly_quota.model_id)
          AND (b.event_type IN ('settlement', 'failure') OR (b.event_type = 'reservation' AND NOT EXISTS (
              SELECT 1 FROM billing_events done WHERE done.generation_id = b.generation_id
                AND done.event_type IN ('settlement', 'failure', 'release'))));

        carryover := GREATEST(0, monthly_quota.hard_limit - last_month_usage - current_month_usage);
        IF has_lifetime THEN
            INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, before, after, reason)
            VALUES ('system', 'system@internal', 'quota.monthly_retired', 'quota', monthly_quota.id::text,
                to_jsonb(monthly_quota), jsonb_build_object('lifetime_quota_id', lifetime_quota.id,
                'carryover_not_added', carryover, 'reason', 'A stricter lifetime quota already enforced this exact scope.'),
                'Monthly-to-lifetime carryover migration');
            UPDATE quotas SET deleted_at = now() WHERE id = monthly_quota.id;
        ELSE
            new_hard_limit := lifetime_usage + carryover;
            UPDATE quotas SET "window" = 'lifetime', hard_limit = new_hard_limit WHERE id = monthly_quota.id;
            INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, before, after, reason)
            VALUES ('system', 'system@internal', 'quota.window_converted', 'quota', monthly_quota.id::text,
                to_jsonb(monthly_quota), jsonb_build_object('window', 'lifetime', 'hard_limit', new_hard_limit,
                'last_month_usage', last_month_usage, 'current_month_usage', current_month_usage, 'carryover', carryover),
                'Monthly-to-lifetime carryover migration');
        END IF;
    END LOOP;
END;
$carryover_lifetime_conversion$`;

await sql.query(migration);
const result = await sql.query(`SELECT "window", count(*)::int AS budgets
    FROM quotas WHERE project_id IS NOT NULL AND deleted_at IS NULL GROUP BY 1 ORDER BY 1`);
console.log(JSON.stringify({ projectBudgets: result }, null, 2));
