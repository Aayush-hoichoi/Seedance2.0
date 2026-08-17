import { getUser } from '../../../lib/auth/user.js';
import { createBudgetRequest, getBudgetRequestContext } from '../../../lib/budgetRequests.mjs';
import { createBudgetRequestRouteHandlers } from '../../../lib/http/budgetRequestHandlers.mjs';
import { notifyTeamsBudgetRequested } from '../../../lib/notify/teams.mjs';

export const runtime = 'nodejs';

const handlers = createBudgetRequestRouteHandlers({
    authenticate: getUser,
    loadContext: getBudgetRequestContext,
    createRequest: createBudgetRequest,
    // Post-commit and best-effort: the request is already in audit_log with its
    // notification event by the time this runs. No-op unless TEAMS_* is set.
    onCreated: ({ id, request }) => notifyTeamsBudgetRequested({ requestId: id, request }),
});

export const GET = handlers.GET;
export const POST = handlers.POST;
