import { NextResponse } from 'next/server';
import { getUser } from '../../../../../../lib/auth/user.js';
import { decideAccessRequest, canReviewAccessRequests } from '../../../../../../lib/access/decideAccessRequest.mjs';
import { teamsConfigured, loadAccessRequestPayload, updateTeamsAccessCards } from '../../../../../../lib/notify/teamsAccess.mjs';

export const runtime = 'nodejs';

// Teams → console needs no code here: a Teams decision calls the exact same
// decideAccessRequest, whose events row the console's SSE stream already
// revalidates on. This is the other direction — a console decision updating
// every Teams card for the request.
async function syncTeamsCards({ id, decision }) {
    if (!teamsConfigured()) return;
    const request = await loadAccessRequestPayload(id);
    if (!request) return;
    await updateTeamsAccessCards({ requestId: id, request, decision });
}

export async function POST(request, { params }) {
    const admin = await getUser();
    if (!canReviewAccessRequests(admin)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const { id, action } = await params;
    if (action !== 'approve' && action !== 'revoke' && action !== 'deny_upgrade') {
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
    const requestId = Number(id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
        return NextResponse.json({ error: 'Invalid request id' }, { status: 400 });
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
        maxResolution = typeof body?.maxResolution === 'string' ? body.maxResolution.slice(0, 12) : null;
    }
    const result = await decideAccessRequest({ id: requestId, action, admin, validUntil, maxResolution });
    if (result.error === 'not_found') {
        return NextResponse.json({ error: action === 'deny_upgrade' ? 'No pending upgrade on that request.' : 'Request not found' }, { status: 404 });
    }
    if (result.error === 'expiry') {
        return NextResponse.json({ error: 'A future expiry time (validUntil) is required to approve.' }, { status: 400 });
    }
    if (result.error) return NextResponse.json({ error: 'Could not decide that request.' }, { status: 400 });

    if (action === 'deny_upgrade') return NextResponse.json({ ok: true, request: result.row });

    // A console decision must reach the Teams cards too — otherwise they sit
    // showing "pending" for a request that is settled. Awaited so a failure is
    // logged in context, never rethrown: the decision is already committed.
    try {
        await syncTeamsCards({
            id: requestId,
            decision: {
                status: result.status, decidedBy: admin.name || admin.email,
                maxResolution: result.row.max_resolution, expiresAt: result.row.expires_at,
            },
        });
    } catch (err) {
        console.error('[access] Teams card sync failed:', err.message);
    }

    if (result.syncError) {
        return NextResponse.json({
            ok: false,
            request: result.row,
            error: `Decision saved, but access was NOT applied: ${result.syncError}. The user still cannot use this model.`,
        }, { status: 500 });
    }
    return NextResponse.json({ ok: true, request: result.row });
}
