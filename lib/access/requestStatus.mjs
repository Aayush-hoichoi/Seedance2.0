// The model-access request state machine, as a pure map. Revoke doubles as
// "reject a pending request" — there is no separate denied state.
const BY_ACTION = { request: 'pending', approve: 'approved', revoke: 'revoked' };

export function nextStatus(action) {
    const status = BY_ACTION[action];
    if (!status) throw new Error(`Unknown action: ${action}`);
    return status;
}

// What a re-request over an existing (user, model, project) row should do.
// 'fresh' (re)opens the request and pings Slack; 'pending' is a duplicate of a
// live request (no ping); 'approved' means a live grant exists — never touch it.
// An approved-but-EXPIRED grant re-opens: the studio has re-locked the model,
// so the user genuinely needs a new decision.
export function reRequestDecision(existing, now = new Date()) {
    if (!existing) return 'fresh';
    if (existing.status === 'pending') return 'pending';
    if (existing.status === 'approved') {
        const expired = existing.expires_at != null && new Date(existing.expires_at) <= now;
        return expired ? 'fresh' : 'approved';
    }
    return 'fresh'; // revoked / denied: the user may ask again
}
