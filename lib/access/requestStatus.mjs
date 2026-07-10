// The model-access request state machine, as a pure map. Revoke doubles as
// "reject a pending request" — there is no separate denied state.
const BY_ACTION = { request: 'pending', approve: 'approved', revoke: 'revoked' };

export function nextStatus(action) {
    const status = BY_ACTION[action];
    if (!status) throw new Error(`Unknown action: ${action}`);
    return status;
}
