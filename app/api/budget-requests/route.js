import { getUser } from '../../../lib/auth/user.js';
import { createBudgetRequest, getBudgetRequestContext } from '../../../lib/budgetRequests.mjs';
import { createBudgetRequestRouteHandlers } from '../../../lib/http/budgetRequestHandlers.mjs';

export const runtime = 'nodejs';

const handlers = createBudgetRequestRouteHandlers({
    authenticate: getUser,
    loadContext: getBudgetRequestContext,
    createRequest: createBudgetRequest,
});

export const GET = handlers.GET;
export const POST = handlers.POST;
