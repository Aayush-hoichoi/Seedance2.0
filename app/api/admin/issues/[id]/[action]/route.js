import { getUser } from '../../../../../../lib/auth/user.js';
import { canReviewIssues, decideIssueReport } from '../../../../../../lib/issueReports.mjs';
import { createIssueDecisionRouteHandler } from '../../../../../../lib/http/issueHandlers.mjs';

export const runtime = 'nodejs';

export const POST = createIssueDecisionRouteHandler({
    authenticate: getUser,
    canReview: canReviewIssues,
    decideReport: decideIssueReport,
});
