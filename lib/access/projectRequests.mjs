// Server-only. Project-creation requests: a member asks an admin for a new
// project by name; approval creates the project AND adds the requester to it.
// Mirrors the model-access request flow (Slack card + console), simpler ledger.

import { getDb } from '../db/neon.js';
import { writeAudit } from '../gateway/db.js';

// Dedupe is per (user, name): a live project with the name means there is
// nothing to create (ask an admin to add you instead), and a still-pending ask
// for the same name must not re-ping Slack. `fresh` tells callers to notify.
export async function requestProject(userId, email, name, note) {
    const sql = await getDb();
    if (!sql) throw new Error('Access store unavailable');
    const [live] = await sql`SELECT id FROM projects
        WHERE lower(name) = lower(${name}) AND archived_at IS NULL LIMIT 1`;
    if (live) return { status: 'exists', fresh: false };
    const [dupe] = await sql`SELECT id FROM project_requests
        WHERE user_id = ${userId} AND lower(name) = lower(${name}) AND status = 'pending' LIMIT 1`;
    if (dupe) return { id: dupe.id, status: 'pending', fresh: false };
    const [row] = await sql`INSERT INTO project_requests (user_id, user_email, name, note)
        VALUES (${userId}, ${email}, ${name}, ${note ?? null}) RETURNING id`;
    return { id: row.id, status: 'pending', fresh: true };
}

export async function listPendingProjectRequests() {
    const sql = await getDb();
    if (!sql) return [];
    return sql`SELECT id, user_id, user_email, name, note, created_at
        FROM project_requests WHERE status = 'pending' ORDER BY created_at DESC`;
}

// Create-then-flip, all idempotent: the status flip is the commit point, so a
// failure part-way leaves the request pending and a retry re-runs safely; a
// raced second approver misses the flip guard and reports already-handled.
// Same semantics as POST /api/projects: an archived same-name project revives,
// a live one just gains the requester — and the requester owns their project.
export async function approveProjectRequest(id, { actorId, actorEmail }) {
    const sql = await getDb();
    if (!sql) throw new Error('Access store unavailable');
    const [req] = await sql`SELECT id, user_id, user_email, name
        FROM project_requests WHERE id = ${id} AND status = 'pending' LIMIT 1`;
    if (!req) return null;
    const [project] = await sql`INSERT INTO projects (name, created_by)
        VALUES (${req.name}, ${req.user_id})
        ON CONFLICT (name) DO UPDATE SET archived_at = NULL
        RETURNING id, name`;
    await sql`INSERT INTO project_memberships (project_id, user_id, role, added_by)
        VALUES (${project.id}, ${req.user_id}, 'admin', ${actorId})
        ON CONFLICT DO NOTHING`;
    const [row] = await sql`UPDATE project_requests
        SET status = 'approved', decided_by = ${actorEmail ?? actorId}, decided_at = now(), project_id = ${project.id}
        WHERE id = ${id} AND status = 'pending'
        RETURNING id, user_id, user_email, name, status, project_id`;
    if (!row) return null;
    await writeAudit(sql, {
        actorId, actorEmail, action: 'project.create',
        targetType: 'project', targetId: project.id,
        after: { name: req.name, requestedBy: req.user_id, via: 'project_request' },
    });
    return row;
}

export async function denyProjectRequest(id, decidedBy) {
    const sql = await getDb();
    if (!sql) throw new Error('Access store unavailable');
    const [row] = await sql`UPDATE project_requests
        SET status = 'denied', decided_by = ${decidedBy}, decided_at = now()
        WHERE id = ${id} AND status = 'pending'
        RETURNING id, user_id, user_email, name, status`;
    return row ?? null;
}
