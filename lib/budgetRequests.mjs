// Budget-increase requests without a schema migration. The existing append-only
// audit_log is the request ledger: one `budget_request.created` row followed by
// at most one approved/denied decision row with the same target_id.

import { randomUUID } from 'node:crypto';
import { getDb } from './db/neon.js';
import { supportedResolutionsFor } from './seedance/constants.js';

export const ALL_MODELS = '*';
export const ALL_MODEL_QUALITIES = ['standard', 'high', 'maximum'];

const cleanMoney = (value) => Math.round(Number(value) * 100) / 100;

// Approval is an increment, never an absolute overwrite. If historical usage
// has already moved beyond the live cap (possible after a soft overage), start
// from the minimum safe cap before adding the approved amount.
export function nextApprovedLimit({ liveLimit = 0, minimumSafeCap = 0, increaseAmount = 0 }) {
    const live = cleanMoney(liveLimit);
    const minimum = cleanMoney(minimumSafeCap);
    const increase = cleanMoney(increaseAmount);
    if (![live, minimum, increase].every(Number.isFinite) || live < 0 || minimum < 0 || increase <= 0) return null;
    return cleanMoney(Math.max(live, minimum) + increase);
}

export function canReviewBudgetRequests(user) {
    return user?.role === 'admin';
}

export function qualityCap(modelId, requestedQuality) {
    const ladder = supportedResolutionsFor(modelId) ?? [];
    if (!ladder.length) return null;
    if (!ALL_MODEL_QUALITIES.includes(requestedQuality)) {
        return ladder.find((tier) => tier.toLowerCase() === String(requestedQuality).toLowerCase()) ?? null;
    }
    if (requestedQuality === 'maximum') return ladder[ladder.length - 1];
    if (requestedQuality === 'high') return ladder[Math.max(0, ladder.length - 2)];
    return ladder[0];
}

async function requestContext(sql, { projectId, userId }) {
    const [member] = await sql`SELECT p.id, p.name FROM projects p
        JOIN project_memberships pm ON pm.project_id = p.id
        WHERE p.id = ${projectId} AND pm.user_id = ${userId}
          AND p.archived_at IS NULL LIMIT 1`;
    if (!member) return null;
    const models = await sql`SELECT m.id, m.display_name, m.category, v.kind
        FROM models m LEFT JOIN model_versions v ON v.id = m.current_version_id
        WHERE m.active = true ORDER BY m.category, m.display_name`;
    const spend = await sql`SELECT model_id,
            COALESCE(SUM(COALESCE(cost_usd, est_cost_usd, 0)), 0)::float8 AS spent
        FROM billing_events
        WHERE project_id = ${projectId} AND user_id = ${userId}
          AND event_type IN ('settlement', 'failure')
        GROUP BY model_id`;
    const quotas = await sql`SELECT model_id, hard_limit::float8 AS hard_limit
        FROM quotas WHERE project_id = ${projectId} AND user_id = ${userId}
          AND type = 'usd' AND "window" = 'lifetime' AND deleted_at IS NULL`;
    return {
        project: member,
        models,
        spendByModel: Object.fromEntries(spend.map((row) => [row.model_id, Number(row.spent)])),
        limitByModel: Object.fromEntries(quotas.map((row) => [row.model_id ?? ALL_MODELS, Number(row.hard_limit)])),
    };
}

export async function getBudgetRequestContext({ projectId, user, sql: providedSql = null }) {
    const sql = providedSql ?? await getDb();
    if (!sql) throw new Error('Budget request store unavailable.');
    const context = await requestContext(sql, { projectId, userId: user.userId });
    if (!context) return null;
    return {
        ...context,
        user: { id: user.userId, name: user.name || user.email, email: user.email },
    };
}

export async function createBudgetRequest({ projectId, user, modelId, quality, increaseAmount, reason, sql: providedSql = null }) {
    const sql = providedSql ?? await getDb();
    if (!sql) throw new Error('Budget request store unavailable.');
    const context = await requestContext(sql, { projectId, userId: user.userId });
    if (!context) throw new Error('You are not a member of that project.');
    const selectedModels = modelId === ALL_MODELS
        ? context.models
        : context.models.filter((model) => model.id === modelId);
    if (!selectedModels.length) throw new Error('Select an active model.');
    if (modelId === ALL_MODELS && !ALL_MODEL_QUALITIES.includes(quality)) {
        throw new Error('Select a valid all-model quality level.');
    }
    const caps = Object.fromEntries(selectedModels.map((model) => [model.id, qualityCap(model.id, quality)]));
    if (Object.values(caps).some((cap) => !cap)) throw new Error('Quality tiers are not configured for every selected model.');
    if (modelId !== ALL_MODELS && !caps[modelId]) throw new Error('Select a quality supported by that model.');
    const amount = cleanMoney(increaseAmount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('The requested increase must be greater than zero.');
    const cleanReason = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
    const spent = modelId === ALL_MODELS
        ? Object.values(context.spendByModel).reduce((sum, value) => sum + Number(value), 0)
        : Number(context.spendByModel[modelId] || 0);
    const currentLimit = Object.prototype.hasOwnProperty.call(context.limitByModel, modelId)
        ? Number(context.limitByModel[modelId])
        : null;
    const requestId = randomUUID();
    const payload = {
        projectId,
        projectName: context.project.name,
        userId: user.userId,
        userName: user.name || user.email,
        userEmail: user.email,
        modelId,
        modelName: modelId === ALL_MODELS ? 'All models' : selectedModels[0].display_name,
        quality,
        qualityCaps: caps,
        spent: cleanMoney(spent),
        currentLimit: currentLimit == null ? null : cleanMoney(currentLimit),
        increaseAmount: amount,
        reason: cleanReason || null,
    };
    // The request ledger row and its notification outbox row are inseparable:
    // if either insert fails, neither is committed and the caller can retry.
    await sql.transaction([
        sql`WITH request_row AS (
                INSERT INTO audit_log
                    (actor_id, actor_email, action, target_type, target_id, after, reason)
                VALUES (${user.userId}, ${user.email}, 'budget_request.created', 'budget_request', ${requestId},
                        ${JSON.stringify(payload)}::jsonb, ${cleanReason || null})
                RETURNING id
            ), notification AS (
                INSERT INTO events (project_id, user_id, type, payload)
                SELECT ${projectId}, ${user.userId}, 'budget.requested',
                       jsonb_build_object(
                           'requestId', ${requestId}::text, 'projectName', ${context.project.name}::text,
                           'userName', ${payload.userName}::text, 'modelName', ${payload.modelName}::text,
                           'increaseAmount', ${amount}::numeric
                       )
                FROM request_row
                RETURNING id
            )
            SELECT id FROM request_row`,
    ]);
    return { id: requestId, request: payload };
}

export async function listBudgetRequests({ sql: providedSql = null } = {}) {
    const sql = providedSql ?? await getDb();
    if (!sql) return [];
    const rows = await sql.query(`
        SELECT created.target_id AS id, created.after AS request, created.created_at,
               decision.action AS decision_action, decision.after AS decision,
               decision.reason AS decision_reason, decision.created_at AS decided_at,
               decision.actor_email AS decided_by
        FROM audit_log created
        LEFT JOIN LATERAL (
            SELECT action, after, reason, created_at, actor_email
            FROM audit_log d
            WHERE d.target_type = 'budget_request' AND d.target_id = created.target_id
              AND d.action IN ('budget_request.approved', 'budget_request.denied')
            ORDER BY d.created_at DESC LIMIT 1
        ) decision ON true
        WHERE created.target_type = 'budget_request' AND created.action = 'budget_request.created'
        ORDER BY (decision.action IS NULL) DESC, created.created_at DESC
    `);
    return rows.map((row) => ({
        id: row.id,
        ...(row.request || {}),
        status: row.decision_action?.endsWith('approved') ? 'approved' : row.decision_action?.endsWith('denied') ? 'denied' : 'pending',
        decision: row.decision || null,
        decisionReason: row.decision_reason || null,
        createdAt: row.created_at,
        decidedAt: row.decided_at,
        decidedBy: row.decided_by,
    }));
}

export async function decideBudgetRequest({ id, action, admin, policy = 'hard', reason = null, approvedAmount = null, sql: providedSql = null }) {
    const sql = providedSql ?? await getDb();
    if (!sql) throw new Error('Budget request store unavailable.');
    const [created] = await sql`SELECT after, created_at FROM audit_log
        WHERE target_type = 'budget_request' AND target_id = ${id}
          AND action = 'budget_request.created' ORDER BY created_at DESC LIMIT 1`;
    if (!created?.after) return { error: 'not_found' };
    const req = created.after;
    const [existingDecision] = await sql`SELECT action FROM audit_log
        WHERE target_type = 'budget_request' AND target_id = ${id}
          AND action IN ('budget_request.approved', 'budget_request.denied') LIMIT 1`;
    if (existingDecision) return { error: 'decided' };
    const cleanReason = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';

    if (action === 'deny') {
        const [, inserted] = await sql.transaction([
            sql`SELECT pg_advisory_xact_lock(hashtext(${`budget-request:${id}`}))`,
            sql`WITH decision AS (
                    INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, after, reason)
                    SELECT ${admin.userId}, ${admin.email}, 'budget_request.denied', 'budget_request', ${id},
                           ${JSON.stringify({ status: 'denied' })}::jsonb, ${cleanReason || null}
                    WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE target_type = 'budget_request' AND target_id = ${id}
                        AND action IN ('budget_request.approved', 'budget_request.denied'))
                    RETURNING id
                ), notification AS (
                    INSERT INTO events (project_id, user_id, type, payload)
                    SELECT ${req.projectId}, ${req.userId}, 'budget.request.denied',
                           jsonb_build_object(
                               'requestId', ${id}::text, 'projectName', ${req.projectName}::text,
                               'modelName', ${req.modelName}::text, 'reason', ${cleanReason || null}::text
                           )
                    FROM decision
                    RETURNING id
                )
                SELECT id FROM decision`,
        ]);
        if (!inserted?.length) return { error: 'decided' };
        return { ok: true, status: 'denied' };
    }

    if (!['soft', 'hard'].includes(policy)) return { error: 'policy' };
    const requestedIncrease = cleanMoney(req.increaseAmount);
    if (!Number.isFinite(requestedIncrease) || requestedIncrease <= 0) return { error: 'limit' };
    // What a user asks for is a proposal, not the decision. An admin may grant
    // less (partial funding) or more (they know a bigger render is coming), so
    // the approved amount is an explicit input. Omitting it approves exactly
    // what was requested, which keeps every existing caller unchanged. It stays
    // an INCREMENT either way — a smaller approval funds less new headroom, it
    // never claws back a cap the user already holds.
    const increase = approvedAmount == null || approvedAmount === ''
        ? requestedIncrease
        : cleanMoney(approvedAmount);
    if (!Number.isFinite(increase) || increase <= 0) return { error: 'amount' };
    const scopedModel = req.modelId === ALL_MODELS ? null : req.modelId;
    const [usedRows, reservedRows] = await Promise.all([
        sql`SELECT COALESCE(SUM(COALESCE(cost_usd, est_cost_usd, 0)), 0)::float8 AS total
            FROM billing_events WHERE project_id = ${req.projectId} AND user_id = ${req.userId}
              AND (${scopedModel}::text IS NULL OR model_id = ${scopedModel})
              AND event_type IN ('settlement','failure')`,
        sql`SELECT COALESCE(SUM(COALESCE(r.cost_usd, r.est_cost_usd, 0)), 0)::float8 AS total
            FROM billing_events r WHERE r.project_id = ${req.projectId} AND r.user_id = ${req.userId}
              AND (${scopedModel}::text IS NULL OR r.model_id = ${scopedModel})
              AND r.event_type = 'reservation'
              AND NOT EXISTS (SELECT 1 FROM billing_events done WHERE done.generation_id = r.generation_id
                  AND done.event_type IN ('settlement','failure','release'))`,
    ]);
    const minimum = cleanMoney(Number(usedRows[0]?.total || 0) + Number(reservedRows[0]?.total || 0));
    const initialLimit = nextApprovedLimit({ liveLimit: 0, minimumSafeCap: minimum, increaseAmount: increase });
    if (initialLimit == null) return { error: 'limit' };

    const modelScope = req.modelId === ALL_MODELS ? null : req.modelId;
    const models = await sql`SELECT id FROM models WHERE active = true ORDER BY id`;
    const selected = modelScope ? models.filter((model) => model.id === modelScope) : models;
    if (!selected.length) return { error: 'model_inactive' };
    const caps = req.qualityCaps || {};
    const resolvedCaps = Object.fromEntries(selected.map((model) => [
        model.id,
        caps[model.id] ?? qualityCap(model.id, req.quality),
    ]));
    if (Object.values(resolvedCaps).some((cap) => !cap)) return { error: 'quality_unconfigured' };
    const [eligible] = await sql`SELECT 1 FROM projects p
        JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = ${req.userId}
        WHERE p.id = ${req.projectId} AND p.archived_at IS NULL LIMIT 1`;
    if (!eligible) return { error: 'requester_ineligible' };
    const lockKey = `budget-request:${id}`;
    const quotaLockKey = `quota:${req.projectId}:${req.userId}:${modelScope ?? '*'}:usd:lifetime`;
    const statements = [
        sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`,
        // Lock the live project and membership rows, then guard the transaction.
        // Removing the member or archiving the project either wins before this
        // point (and makes the guard fail) or waits until the decision commits.
        sql`SELECT p.id FROM projects p
            JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = ${req.userId}
            WHERE p.id = ${req.projectId} AND p.archived_at IS NULL
            FOR UPDATE OF p, pm`,
        sql`SELECT 1 / CASE WHEN EXISTS (
                SELECT 1 FROM projects p JOIN project_memberships pm
                  ON pm.project_id = p.id AND pm.user_id = ${req.userId}
                WHERE p.id = ${req.projectId} AND p.archived_at IS NULL
            ) THEN 1 ELSE 0 END AS requester_eligibility_guard`,
        sql`SELECT pg_advisory_xact_lock(hashtext(${quotaLockKey}))`,
        // Do not use ON CONFLICT here. Older/local databases may not carry the
        // expression-based quotas scope index, and budget requests explicitly
        // need to work without a schema migration. The advisory lock makes the
        // guarded update-or-insert deterministic for this exact scope.
        sql`UPDATE quotas
            SET hard_limit = GREATEST(hard_limit, ${minimum}) + ${increase},
                policy = ${policy}, soft_overage_pct = ${policy === 'soft' ? 5 : 0},
                alert_thresholds = ${[80, 90, 100]}, created_by = ${admin.userId}
            WHERE project_id IS NOT DISTINCT FROM ${req.projectId}
              AND user_id IS NOT DISTINCT FROM ${req.userId}
              AND model_id IS NOT DISTINCT FROM ${modelScope}
              AND type = 'usd' AND "window" = 'lifetime' AND deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM audit_log WHERE target_type = 'budget_request' AND target_id = ${id}
                  AND action IN ('budget_request.approved', 'budget_request.denied'))`,
        sql`INSERT INTO quotas
            (project_id, user_id, model_id, type, "window", hard_limit, policy, soft_overage_pct, alert_thresholds, created_by)
            SELECT ${req.projectId}, ${req.userId}, ${modelScope}, 'usd', 'lifetime', ${initialLimit}, ${policy}, ${policy === 'soft' ? 5 : 0}, ${[80, 90, 100]}, ${admin.userId}
            WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE target_type = 'budget_request' AND target_id = ${id}
                AND action IN ('budget_request.approved', 'budget_request.denied'))
              AND NOT EXISTS (SELECT 1 FROM quotas
                  WHERE project_id IS NOT DISTINCT FROM ${req.projectId}
                    AND user_id IS NOT DISTINCT FROM ${req.userId}
                    AND model_id IS NOT DISTINCT FROM ${modelScope}
                    AND type = 'usd' AND "window" = 'lifetime' AND deleted_at IS NULL)`,
    ];
    for (const model of selected) {
        const cap = resolvedCaps[model.id];
        // Ladder positions decide which tier is higher; '4K' vs '1080p' means
        // nothing lexically. Lowercased because the column holds both '4k' and
        // '4K' historically (resolutionWithinTier compares case-insensitively).
        const ladder = (supportedResolutionsFor(model.id) ?? []).map((tier) => tier.toLowerCase());
        // RAISE-ONLY. A budget request is about money, not permission, so
        // approving one must never narrow a quality tier an admin granted
        // deliberately through the access-request flow. It used to assign `cap`
        // unconditionally: on 2026-08-10 an all-models request at "high"
        // silently dropped a seedream-5.0-pro grant from 4K to 2K fifteen
        // minutes after an admin approved it, and the console kept showing 4K
        // because that reads model_access_requests, not this table.
        //   • NULL max_resolution means uncapped — the highest tier there is,
        //     so it stays NULL rather than being narrowed to `cap`.
        //   • A stored tier absent from the ladder is unusable, so `cap` wins.
        //   • An unknown `cap` leaves the existing value alone (array_position
        //     yields NULL, the comparison is NULL, and the ELSE branch holds).
        // `prev` reads the pre-update value from the statement's own snapshot,
        // so the audit row can record what actually changed. Previously these
        // writes produced NO audit entry at all — only budget_request.approved
        // — and since UPDATE leaves created_at alone, a downgraded row still
        // looked like it had been written by the approval that granted it.
        statements.push(sql`WITH prev AS (
                SELECT id, max_resolution AS before_res FROM user_model_overrides
                WHERE project_id = ${req.projectId} AND user_id = ${req.userId} AND model_id = ${model.id}
            ), upd AS (
                UPDATE user_model_overrides o
                SET effect = 'allow', valid_from = NULL, valid_until = NULL,
                    created_by = ${admin.userId}, revoked_at = NULL,
                    max_resolution = CASE
                        WHEN o.max_resolution IS NULL THEN NULL
                        WHEN array_position(${ladder}::text[], lower(o.max_resolution)) IS NULL THEN ${cap}::text
                        WHEN array_position(${ladder}::text[], lower(${cap}::text))
                           > array_position(${ladder}::text[], lower(o.max_resolution)) THEN ${cap}::text
                        ELSE o.max_resolution
                    END
                FROM prev
                WHERE o.id = prev.id
                  AND NOT EXISTS (SELECT 1 FROM audit_log WHERE target_type = 'budget_request' AND target_id = ${id}
                      AND action IN ('budget_request.approved', 'budget_request.denied'))
                RETURNING o.id, prev.before_res, o.max_resolution AS after_res
            )
            INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, before, after, reason)
            SELECT ${admin.userId}::text, ${admin.email}::text, 'override.allow', 'user_model_override', upd.id::text,
                   jsonb_build_object('maxResolution', upd.before_res),
                   jsonb_build_object('projectId', ${req.projectId}::int, 'userId', ${req.userId}::text,
                                      'modelId', ${model.id}::text, 'effect', 'allow', 'maxResolution', upd.after_res),
                   ${`budget request ${id}`}::text
            FROM upd WHERE upd.after_res IS DISTINCT FROM upd.before_res`);
        statements.push(sql`WITH ins AS (
                INSERT INTO user_model_overrides
                (project_id, user_id, model_id, effect, max_resolution, valid_from, valid_until, created_by, revoked_at)
                SELECT ${req.projectId}, ${req.userId}, ${model.id}, 'allow', ${cap}, NULL, NULL, ${admin.userId}, NULL
                WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE target_type = 'budget_request' AND target_id = ${id}
                    AND action IN ('budget_request.approved', 'budget_request.denied'))
                  AND NOT EXISTS (SELECT 1 FROM user_model_overrides
                      WHERE project_id = ${req.projectId} AND user_id = ${req.userId} AND model_id = ${model.id})
                RETURNING id, max_resolution
            )
            INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, after, reason)
            SELECT ${admin.userId}::text, ${admin.email}::text, 'override.allow', 'user_model_override', ins.id::text,
                   jsonb_build_object('projectId', ${req.projectId}::int, 'userId', ${req.userId}::text,
                                      'modelId', ${model.id}::text, 'effect', 'allow', 'maxResolution', ins.max_resolution),
                   ${`budget request ${id}`}::text
            FROM ins`);
    }
    const decision = {
        status: 'approved', policy, approvedIncrease: increase, requestedIncrease,
        amountAdjusted: increase !== requestedIncrease, minimumAtApproval: minimum,
    };
    statements.push(sql`WITH decision_row AS (
            INSERT INTO audit_log
                (actor_id, actor_email, action, target_type, target_id, after, reason)
            SELECT ${admin.userId}, ${admin.email}, 'budget_request.approved', 'budget_request', ${id},
                   ${JSON.stringify(decision)}::jsonb || jsonb_build_object('limit', (
                       SELECT MIN(hard_limit)::float8 FROM quotas
                       WHERE project_id IS NOT DISTINCT FROM ${req.projectId}
                         AND user_id IS NOT DISTINCT FROM ${req.userId}
                         AND model_id IS NOT DISTINCT FROM ${modelScope}
                         AND type = 'usd' AND "window" = 'lifetime' AND deleted_at IS NULL
                   )), ${cleanReason || null}
            WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE target_type = 'budget_request' AND target_id = ${id}
                AND action IN ('budget_request.approved', 'budget_request.denied'))
            RETURNING id, after
        ), budget_notification AS (
            INSERT INTO events (project_id, user_id, type, payload)
            SELECT ${req.projectId}, ${req.userId}, 'budget.request.approved',
                   jsonb_build_object(
                       'requestId', ${id}::text, 'projectName', ${req.projectName}::text,
                       'modelName', ${req.modelName}::text, 'policy', ${policy}::text,
                       'limit', decision_row.after->'limit', 'hardLimit', decision_row.after->'limit',
                       'approvedIncrease', ${increase}::numeric, 'requestedIncrease', ${requestedIncrease}::numeric
                   )
            FROM decision_row
            RETURNING id
        ), access_notification AS (
            INSERT INTO events (project_id, user_id, type, payload)
            SELECT ${req.projectId}, ${req.userId}, 'access.granted',
                   jsonb_build_object(
                       'modelId', ${req.modelId}::text, 'scope', 'user',
                       'maxResolution', ${req.quality}::text, 'via', 'budget_request'
                   )
            FROM decision_row
            RETURNING id
        )
        SELECT after FROM decision_row`);
    let results;
    try {
        results = await sql.transaction(statements);
    } catch (error) {
        // The eligibility guard uses division by zero to abort the transaction
        // if membership/project state changes after the optimistic precheck but
        // before its rows are locked.
        if (error?.code === '22012' || /division by zero/i.test(error?.message || '')) {
            return { error: 'requester_ineligible' };
        }
        throw error;
    }
    const approvedDecision = results[results.length - 1]?.[0]?.after;
    if (!approvedDecision) return { error: 'decided' };
    return { ok: true, ...approvedDecision };
}
