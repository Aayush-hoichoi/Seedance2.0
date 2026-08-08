import { getUser } from '../../../../../../lib/auth/user.js';
import { canReviewBudgetRequests, decideBudgetRequest } from '../../../../../../lib/budgetRequests.mjs';
import { createBudgetDecisionRouteHandler } from '../../../../../../lib/http/budgetRequestHandlers.mjs';

export const runtime = 'nodejs';

export const POST = createBudgetDecisionRouteHandler({
    authenticate: getUser,
    canReview: canReviewBudgetRequests,
    decideRequest: decideBudgetRequest,
});
