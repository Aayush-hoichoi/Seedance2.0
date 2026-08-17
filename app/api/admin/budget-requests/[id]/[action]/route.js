import { getUser } from '../../../../../../lib/auth/user.js';
import { canReviewBudgetRequests, decideBudgetRequest } from '../../../../../../lib/budgetRequests.mjs';
import { createBudgetDecisionRouteHandler } from '../../../../../../lib/http/budgetRequestHandlers.mjs';
import { loadBudgetRequestPayload, updateTeamsBudgetCards } from '../../../../../../lib/notify/teams.mjs';

export const runtime = 'nodejs';

// Console → Teams. The other direction needs no code: a decision made in Teams
// calls the same decideBudgetRequest, whose transaction emits the
// budget.request.approved/denied event that the console already revalidates on
// (ConsoleShell's REFRESH map). This closes the loop the other way.
async function syncTeamsCards({ id, action, admin, decision }) {
    const request = await loadBudgetRequestPayload(id);
    if (!request) return;
    await updateTeamsBudgetCards({
        requestId: id,
        request,
        decision: {
            status: action === 'approve' ? 'approved' : 'denied',
            decidedBy: admin?.name || admin?.email || 'an admin',
            ...(action === 'approve' ? decision : {}),
        },
    });
}

export const POST = createBudgetDecisionRouteHandler({
    authenticate: getUser,
    canReview: canReviewBudgetRequests,
    decideRequest: decideBudgetRequest,
    onDecided: syncTeamsCards,
});
