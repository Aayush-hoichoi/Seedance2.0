// Generation issue reports without a schema migration. Same shape as
// lib/budgetRequests.mjs: the append-only audit_log IS the ledger — one
// `issue.reported` row followed by at most one `issue.resolved` / `issue.dismissed`
// row carrying the same target_id.
//
// What makes a report worth reading is the enrichment: the browser only ever
// sees the message it managed to fetch, while the gateway writes the provider's
// real error object onto the `jobs` row (lib/gateway/videoCreate.mjs). We join
// the two here, at report time, so the admin card carries both.

import { randomUUID } from 'node:crypto';
import { getDb } from './db/neon.js';

const text = (value, max) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : null;
};

// Client-supplied counters are untrusted display data, not authorization —
// clamp them to something a human could plausibly have done and move on.
const count = (value) => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n > 0 ? Math.min(n, 999) : null;
};

// The failed generation's identity, and therefore the dedup key: one failure
// yields one report however many times the button is pressed. taskId (video) or
// genId (image) when the request reached a provider; the studio's own job id
// when it never got that far, which is exactly the case worth reporting.
export function jobKey(jobRef = {}) {
    return text(jobRef.taskId, 200) || text(jobRef.genId, 200) || text(jobRef.clientJobId, 200);
}

export function canReviewIssues(user) {
    return user?.role === 'admin';
}

async function membership(sql, { projectId, userId }) {
    const [row] = await sql`SELECT p.id, p.name FROM projects p
        JOIN project_memberships pm ON pm.project_id = p.id
        WHERE p.id = ${projectId} AND pm.user_id = ${userId}
          AND p.archived_at IS NULL LIMIT 1`;
    return row ?? null;
}

// The studio sends the id from lib/seedance/constants.js, which may be either a
// catalog id or a version tag — resolve both, exactly like /api/budgets/me does.
async function modelName(sql, modelId) {
    if (!modelId) return null;
    const [row] = await sql`SELECT m.display_name FROM models m
        LEFT JOIN model_versions v ON v.model_id = m.id
        WHERE m.id = ${modelId} OR v.version_tag = ${modelId} LIMIT 1`;
    return row?.display_name ?? null;
}

// Scoped to the reporter's own project + user id: a report can only ever attach
// a job row that already belonged to the person reporting it.
async function serverJobFor(sql, { projectId, userId, taskId, genId }) {
    if (!taskId && !genId) return null;
    const [row] = await sql`SELECT id, status, attempt, provider_id, error, request_body, created_at, finished_at
        FROM jobs
        WHERE project_id = ${projectId} AND user_id = ${userId}
          AND ((${taskId}::text IS NOT NULL AND provider_task_id = ${taskId}::text)
            OR (${genId}::text IS NOT NULL AND id::text = ${genId}::text))
        ORDER BY id DESC LIMIT 1`;
    return row ?? null;
}

export async function createIssueReport({ projectId, user, report = {}, sql: providedSql = null }) {
    const sql = providedSql ?? await getDb();
    if (!sql) throw new Error('Issue store unavailable.');
    const project = await membership(sql, { projectId, userId: user.userId });
    if (!project) throw new Error('You are not a member of that project.');

    const jobRef = report.jobRef || {};
    const key = jobKey(jobRef);
    if (!key) throw new Error('Report a specific generation — this one has nothing to identify it.');
    const taskId = text(jobRef.taskId, 200);
    const genId = text(jobRef.genId, 200);
    const modelId = text(report.modelId, 200);

    const [displayName, serverJob] = await Promise.all([
        modelName(sql, modelId),
        serverJobFor(sql, { projectId, userId: user.userId, taskId, genId }),
    ]);

    const issueId = randomUUID();
    const payload = {
        projectId,
        projectName: project.name,
        userId: user.userId,
        userName: user.name || user.email,
        userEmail: user.email,
        modelId,
        modelName: displayName || modelId || 'Unknown model',
        jobRef: { key, taskId, genId, clientJobId: text(jobRef.clientJobId, 200), mediaType: text(jobRef.mediaType, 20) },
        attempts: {
            userRetries: count(report.attempts?.userRetries) ?? 1,
            submitAttempts: count(report.attempts?.submitAttempts),
            serverAttempt: serverJob?.attempt == null ? null : Number(serverJob.attempt),
        },
        modeId: text(report.modeId, 60),
        options: report.options && typeof report.options === 'object' ? report.options : null,
        prompt: text(report.prompt, 1000),
        note: text(report.note, 500),
        clientError: text(report.error, 4000),
        server: serverJob ? {
            jobId: serverJob.id,
            status: serverJob.status,
            providerId: serverJob.provider_id,
            error: serverJob.error ?? null,
            requestBody: serverJob.request_body ?? null,
            finishedAt: serverJob.finished_at ?? null,
        } : null,
    };
    const summary = (payload.clientError || payload.server?.error?.message || 'Generation failed.').slice(0, 200);

    // The ledger row and its notification are inseparable, same as budget
    // requests: if either insert fails neither commits and the user can retry.
    // The NOT EXISTS guard is the dedup — a second press of the same button
    // inserts nothing and returns no rows.
    const [rows] = await sql.transaction([
        sql`WITH report_row AS (
                INSERT INTO audit_log
                    (actor_id, actor_email, action, target_type, target_id, after, reason)
                SELECT ${user.userId}, ${user.email}, 'issue.reported', 'issue', ${issueId},
                       ${JSON.stringify(payload)}::jsonb, ${payload.note}
                WHERE NOT EXISTS (
                    SELECT 1 FROM audit_log
                    WHERE target_type = 'issue' AND action = 'issue.reported'
                      AND actor_id = ${user.userId} AND after->'jobRef'->>'key' = ${key}
                )
                RETURNING id
            ), notification AS (
                INSERT INTO events (project_id, user_id, type, payload)
                SELECT ${projectId}, ${user.userId}, 'issue.reported',
                       jsonb_build_object(
                           'issueId', ${issueId}::text, 'projectName', ${project.name}::text,
                           'userName', ${payload.userName}::text, 'modelName', ${payload.modelName}::text,
                           'attempts', ${payload.attempts.userRetries}::int,
                           'errorSummary', ${summary}::text
                       )
                FROM report_row
                RETURNING id
            )
            SELECT id FROM report_row`,
    ]);
    if (!rows?.length) return { duplicate: true };
    return { id: issueId, report: payload };
}

export async function listIssueReports({ sql: providedSql = null } = {}) {
    const sql = providedSql ?? await getDb();
    if (!sql) return [];
    const rows = await sql.query(`
        SELECT created.target_id AS id, created.after AS report, created.created_at,
               decision.action AS decision_action, decision.reason AS decision_note,
               decision.created_at AS decided_at, decision.actor_email AS decided_by
        FROM audit_log created
        LEFT JOIN LATERAL (
            SELECT action, reason, created_at, actor_email
            FROM audit_log d
            WHERE d.target_type = 'issue' AND d.target_id = created.target_id
              AND d.action IN ('issue.resolved', 'issue.dismissed')
            ORDER BY d.created_at DESC LIMIT 1
        ) decision ON true
        WHERE created.target_type = 'issue' AND created.action = 'issue.reported'
        ORDER BY (decision.action IS NULL) DESC, created.created_at DESC
    `);
    return rows.map((row) => ({
        id: row.id,
        ...(row.report || {}),
        status: row.decision_action === 'issue.resolved' ? 'resolved'
            : row.decision_action === 'issue.dismissed' ? 'dismissed' : 'open',
        decisionNote: row.decision_note || null,
        createdAt: row.created_at,
        decidedAt: row.decided_at,
        decidedBy: row.decided_by,
    }));
}

// The live SSE stream starts at "now" on every page load (app/api/events/
// route.js), so a decision made while the reporter was offline never reaches
// them. This is the replay half: recent decisions on the caller's own reports;
// the studio dedups against a localStorage seen-set and shows the rest once.
export async function listMyIssueDecisions({ userId, sql: providedSql = null }) {
    const sql = providedSql ?? await getDb();
    if (!sql) return [];
    const rows = await sql`SELECT d.target_id AS id, d.action, d.reason, d.created_at,
               created.after->>'modelName' AS model_name
        FROM audit_log d
        JOIN audit_log created ON created.target_type = 'issue'
            AND created.action = 'issue.reported'
            AND created.target_id = d.target_id AND created.actor_id = ${userId}
        WHERE d.target_type = 'issue' AND d.action IN ('issue.resolved', 'issue.dismissed')
          AND d.created_at > now() - interval '30 days'
        ORDER BY d.created_at DESC LIMIT 20`;
    return rows.map((row) => ({
        id: row.id,
        status: row.action === 'issue.resolved' ? 'resolved' : 'dismissed',
        note: row.reason || null,
        modelName: row.model_name || null,
        decidedAt: row.created_at,
    }));
}

export async function decideIssueReport({ id, action, admin, note = null, sql: providedSql = null }) {
    const sql = providedSql ?? await getDb();
    if (!sql) throw new Error('Issue store unavailable.');
    const [created] = await sql`SELECT after FROM audit_log
        WHERE target_type = 'issue' AND target_id = ${id}
          AND action = 'issue.reported' ORDER BY created_at DESC LIMIT 1`;
    if (!created?.after) return { error: 'not_found' };
    const report = created.after;
    const [existing] = await sql`SELECT action FROM audit_log
        WHERE target_type = 'issue' AND target_id = ${id}
          AND action IN ('issue.resolved', 'issue.dismissed') LIMIT 1`;
    if (existing) return { error: 'decided' };

    const cleanNote = text(note, 500);
    const status = action === 'resolve' ? 'resolved' : 'dismissed';
    const decisionAction = action === 'resolve' ? 'issue.resolved' : 'issue.dismissed';
    // The event is scoped to the reporter's user id, which under the audience
    // rules (lib/gateway/eventAudience.mjs) means the reporter and every admin —
    // so other admins' Issues tabs revalidate without a poll loop.
    const [, rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtext(${`issue:${id}`}))`,
        sql`WITH decision AS (
                INSERT INTO audit_log
                    (actor_id, actor_email, action, target_type, target_id, after, reason)
                SELECT ${admin.userId}, ${admin.email}, ${decisionAction}, 'issue', ${id},
                       ${JSON.stringify({ status })}::jsonb, ${cleanNote}
                WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE target_type = 'issue' AND target_id = ${id}
                    AND action IN ('issue.resolved', 'issue.dismissed'))
                RETURNING id
            ), notification AS (
                INSERT INTO events (project_id, user_id, type, payload)
                SELECT ${report.projectId ?? null}, ${report.userId ?? null}, 'issue.decided',
                       jsonb_build_object(
                           'issueId', ${id}::text, 'status', ${status}::text,
                           'projectName', ${report.projectName ?? null}::text,
                           'note', ${cleanNote}::text
                       )
                FROM decision
                RETURNING id
            )
            SELECT id FROM decision`,
    ]);
    if (!rows?.length) return { error: 'decided' };
    return { ok: true, status };
}
