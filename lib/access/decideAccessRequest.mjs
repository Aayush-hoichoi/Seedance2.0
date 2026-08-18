// One decision, however it was made — console click or Teams link. Mirrors
// decideBudgetRequest's role for the budget-request flow: whichever surface
// acts, the gateway override write, the audit trail, and the requester
// notification are identical. Extracted from the console's
// app/api/admin/requests/[id]/[action]/route.js so a second surface (Teams)
// doesn't need a second implementation of any of that.

import { getDb } from '../db/neon.js';
import { setRequestStatus, denyUpgrade } from './db.js';
import { nextStatus } from './requestStatus.mjs';
import { syncGatewayOverride } from './gatewaySync.mjs';
import { notifySlackAccessDecided } from '../notify/slack.mjs';
import { emitEvent } from '../gateway/db.js';

export function canReviewAccessRequests(user) {
    return user?.role === 'admin';
}

// → { error: 'unknown_action' | 'expiry' | 'not_found' }
// | { ok: true, row, status: 'approved' | 'revoked' | 'upgrade_declined', syncError? }
export async function decideAccessRequest({ id, action, admin, validUntil = null, maxResolution = null, reason = null }) {
    if (!['approve', 'revoke', 'deny_upgrade'].includes(action)) return { error: 'unknown_action' };

    // deny_upgrade clears only the parked tier ask — the live grant and its
    // gateway override stay untouched, so no sync. It's still declining
    // something the user asked for, so the requester is told, same as a
    // plain denial below.
    if (action === 'deny_upgrade') {
        const row = await denyUpgrade(id, admin.email);
        if (!row) return { error: 'not_found' };
        await notifyRequesterDenied(row, reason, { upgradeDeclined: true });
        return { ok: true, row, status: 'upgrade_declined' };
    }

    // Approving requires a future expiry — the grant is time-boxed.
    if (action === 'approve') {
        const at = validUntil ? Date.parse(validUntil) : NaN;
        if (!validUntil || Number.isNaN(at) || at <= Date.now()) return { error: 'expiry' };
    }

    // Needed only to tell "a still-pending request just got declined" (nobody
    // has been told yet) apart from "an active grant just got revoked"
    // (syncGatewayOverride below already emits access.revoked for that case,
    // and that path already reaches the requester).
    let wasPending = false;
    if (action === 'revoke') {
        const sql = await getDb();
        if (sql) {
            const [before] = await sql`SELECT status FROM model_access_requests WHERE id = ${id}`;
            wasPending = before?.status === 'pending';
        }
    }

    const row = await setRequestStatus(id, nextStatus(action), admin.email, validUntil, maxResolution);
    if (!row) return { error: 'not_found' };

    // The override is what the gateway actually enforces — the status row above
    // only DISPLAYS the decision. A silent failure here reads as a granted
    // approval the user can't use, so report it instead of swallowing it.
    let syncError = null;
    try {
        await syncGatewayOverride({ action, row, admin, validUntil });
    } catch (err) {
        syncError = err.message;
        console.error('[access] gateway override sync failed:', err.message);
    }

    if (action === 'revoke' && wasPending) await notifyRequesterDenied(row, reason);

    // Post the outcome (approved / declined) to Slack. Best-effort, and fires
    // regardless of which surface decided — same as the Slack call this
    // replaces from the console route.
    notifySlackAccessDecided({
        email: row.user_email, modelId: row.model_id, status: row.status,
        expiresAt: row.expires_at, maxResolution: row.max_resolution,
    }).catch(() => {});

    return { ok: true, row, status: row.status, syncError };
}

// A denied/revoked-while-pending request produces no override change for
// syncGatewayOverride to notify about, so it's the one outcome that function
// cannot tell the requester about on its own.
async function notifyRequesterDenied(row, reason, { upgradeDeclined = false } = {}) {
    try {
        const sql = await getDb();
        if (!sql) return;
        await emitEvent(sql, {
            projectId: row.project_id, userId: row.user_id,
            type: 'access.request.denied',
            payload: { requestId: row.id, modelId: row.model_id, reason: reason || null, upgradeDeclined },
        });
    } catch (err) {
        console.error('[access] denial notification failed:', err.message);
    }
}
