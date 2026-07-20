// The model-access request state machine, as a pure map. Revoke doubles as
// "reject a pending request" — there is no separate denied state.
const BY_ACTION = { request: 'pending', approve: 'approved', revoke: 'revoked' };

export function nextStatus(action) {
    const status = BY_ACTION[action];
    if (!status) throw new Error(`Unknown action: ${action}`);
    return status;
}

// What a Slack Deny click means, resolved against LIVE state rather than the
// intent frozen into the card when it was posted. Cards live in the channel
// forever and the request row is reused per (user, model, project), so an old
// "New model-access request" card still carries a plain access_deny long after
// that request became a live grant — clicking it must not pull the grant.
//
// `upgradeRow` is the result of the atomic denyUpgrade UPDATE (non-null only
// when the row was an approved grant with a parked tier upgrade — i.e. the
// thing actually awaiting a decision is the upgrade, not the grant).
//   'upgrade_declined' — parked tier ask cleared, live grant untouched
//   'already_handled'  — an upgrade card whose upgrade is already decided
//   'revoke'           — a genuine pending request being declined
export function resolveDeny(upgradeRow, { fromUpgradeCard = false } = {}) {
    if (upgradeRow) return 'upgrade_declined';
    return fromUpgradeCard ? 'already_handled' : 'revoke';
}

// What a re-request over an existing (user, model, project) row should do.
// 'fresh' (re)opens the request and pings Slack; 'pending' is a duplicate of a
// live request (no ping); 'approved' means a live grant exists — never touch it.
// An approved-but-EXPIRED grant re-opens: the studio has re-locked the model,
// so the user genuinely needs a new decision.
//
// With a wantedTier + the model's tier ladder, re-asks over live rows refine:
//   'covered'      — the live grant already includes the wanted tier: no-op
//   'upgrade'      — wanted tier is above the live grant's cap: park it in
//                    pending_max_resolution (grant stays live) and ping Slack
//   'pending_bump' — still-pending ask, different tier: update the ask, re-ping
// Duplicates (same tier as what's already asked/pending) stay 'pending' — no
// re-ping. Without a wantedTier the original three verdicts apply unchanged.
export function reRequestDecision(existing, now = new Date(), wantedTier = null, ladder = null) {
    if (!existing) return 'fresh';
    const sameTier = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
    if (existing.status === 'pending') {
        if (wantedTier != null && !sameTier(wantedTier, existing.max_resolution)) return 'pending_bump';
        return 'pending';
    }
    if (existing.status === 'approved') {
        const expired = existing.expires_at != null && new Date(existing.expires_at) <= now;
        if (expired) return 'fresh';
        if (wantedTier == null || !Array.isArray(ladder)) return 'approved';
        if (existing.pending_max_resolution != null && sameTier(wantedTier, existing.pending_max_resolution)) return 'pending';
        const idx = (v) => ladder.findIndex((t) => sameTier(t, v));
        const cap = idx(existing.max_resolution);
        const want = idx(wantedTier);
        // cap < 0 = uncapped grant (or unknown token) → everything is covered.
        // The deploy backfill sets a tier on every legacy grant, so a NULL cap
        // on a live row means a deliberately unlimited one.
        if (cap < 0 || want < 0 || want <= cap) return 'covered';
        return 'upgrade';
    }
    return 'fresh'; // revoked / denied: the user may ask again
}
