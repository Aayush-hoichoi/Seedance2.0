import { NextResponse } from 'next/server';
import { getUser } from '../../../../../../lib/auth/user.js';
import { setRequestStatus, denyUpgrade } from '../../../../../../lib/access/db.js';
import { nextStatus } from '../../../../../../lib/access/requestStatus.mjs';
import { syncGatewayOverride } from '../../../../../../lib/access/gatewaySync.mjs';
import { notifySlackAccessDecided } from '../../../../../../lib/notify/slack.mjs';

export const runtime = 'nodejs';

export async function POST(request, { params }) {
    const admin = await getUser();
    if (!admin || admin.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const { id, action } = await params;
    if (action !== 'approve' && action !== 'revoke' && action !== 'deny_upgrade') {
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
    const requestId = Number(id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
        return NextResponse.json({ error: 'Invalid request id' }, { status: 400 });
    }
    // deny_upgrade clears only the parked tier ask — the live grant and its
    // gateway override stay untouched, so no sync and no revoke notification.
    if (action === 'deny_upgrade') {
        const row = await denyUpgrade(requestId, admin.email);
        if (!row) return NextResponse.json({ error: 'No pending upgrade on that request.' }, { status: 404 });
        return NextResponse.json({ ok: true, request: row });
    }
    // Approving requires a future expiry — the grant is time-boxed. The admin
    // may also pick the granted quality tier (possibly lower than requested);
    // null keeps the tier the user asked for.
    // ponytail: tier tokens are trusted shape-only here (admin-only endpoint,
    // console select only offers valid tiers); enforcement treats unknown as uncapped.
    let validUntil = null;
    let maxResolution = null;
    if (action === 'approve') {
        const body = await request.json().catch(() => null);
        validUntil = body?.validUntil ?? null;
        const at = validUntil ? Date.parse(validUntil) : NaN;
        if (!validUntil || Number.isNaN(at) || at <= Date.now()) {
            return NextResponse.json({ error: 'A future expiry time (validUntil) is required to approve.' }, { status: 400 });
        }
        maxResolution = typeof body?.maxResolution === 'string' ? body.maxResolution.slice(0, 12) : null;
    }
    const row = await setRequestStatus(requestId, nextStatus(action), admin.email, validUntil, maxResolution);
    if (!row) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    try {
        await syncGatewayOverride({ action, row, admin, validUntil });
    } catch (err) {
        console.error('[access] gateway override sync failed:', err.message); // legacy status is already saved
    }
    // Post the outcome (approved / declined) to Slack. Best-effort.
    await notifySlackAccessDecided({ email: row.user_email, modelId: row.model_id, status: row.status, expiresAt: row.expires_at, maxResolution: row.max_resolution }).catch(() => {});
    return NextResponse.json({ ok: true, request: row });
}
