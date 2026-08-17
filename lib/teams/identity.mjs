// Who is this Teams user, and may they decide a budget request?
//
// Two gates, and BOTH are required. verify.mjs proves Microsoft sent the
// request; this proves an authorised person sent it. Either alone is
// insufficient — a valid Bot Framework token only means *some* Teams user in
// the tenant tapped a button.
//
// Matching is by exact AAD object id, never by name or email. The Teams bot
// reference doc resolves recipients by displayName because hoichoi, Sooper and
// LoglineAI share one tenant across several verified domains, so a recorded
// @hoichoi.tv address can belong to a different sign-in identity. That is fine
// for ADDRESSING a message and unacceptable for AUTHORISING one that moves
// money: a near-match would hand someone else's approval rights over.

import { getDb } from '../db/neon.js';
import { approverIds } from '../notify/teams.mjs';

// → { ok: true, admin: { userId, email, name, role } } | { ok: false, reason }
//
// The returned admin is written into audit_log as the actor, which is what
// makes a Teams decision indistinguishable from a console one.
export async function resolveTeamsAdmin(aadObjectId, { sql: providedSql = null } = {}) {
    const id = String(aadObjectId || '').trim();
    if (!id) return { ok: false, reason: 'no aadObjectId on the activity' };
    // Allowlist first: cheap, and it means an id we never sent a card to cannot
    // reach the database lookup at all.
    if (!approverIds().includes(id)) return { ok: false, reason: 'not an approver' };

    const sql = providedSql ?? await getDb();
    if (!sql) return { ok: false, reason: 'identity store unavailable' };
    const [user] = await sql`SELECT id, email, name, role FROM users
        WHERE teams_aad_object_id = ${id} AND deleted_at IS NULL LIMIT 1`;
    if (!user) {
        // Deliberately explicit: the fix is an operator action, and a vague
        // "forbidden" would send someone hunting through Teams config instead.
        return { ok: false, reason: 'teams identity is not linked to an app user' };
    }
    if (user.role !== 'admin') return { ok: false, reason: 'not an admin' };
    return { ok: true, admin: { userId: user.id, email: user.email, name: user.name, role: user.role } };
}

// Every id in TEAMS_ADMIN_AAD_IDS must resolve to an admin account, because
// that list decides BOTH who receives a card and who may act on one. An id with
// no linked user still gets a card with live Approve/Deny buttons — and every
// tap is refused. The recipient sees a button that does nothing and has no way
// to know the fix is a database link they cannot perform.
//
// → [{ aadObjectId, linked, admin?, reason? }]
export async function describeApprovers({ sql: providedSql = null } = {}) {
    const sql = providedSql ?? await getDb();
    const ids = approverIds();
    if (!sql) return ids.map((aadObjectId) => ({ aadObjectId, linked: false, reason: 'identity store unavailable' }));
    return Promise.all(ids.map(async (aadObjectId) => {
        const resolved = await resolveTeamsAdmin(aadObjectId, { sql });
        return resolved.ok
            ? { aadObjectId, linked: true, admin: resolved.admin }
            : { aadObjectId, linked: false, reason: resolved.reason };
    }));
}
