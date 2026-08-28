import { getUser } from '../../../lib/auth/user.js';
import { createIssueReport } from '../../../lib/issueReports.mjs';
import { createIssueRouteHandler } from '../../../lib/http/issueHandlers.mjs';
import { notifyTeamsIssueReported } from '../../../lib/notify/teamsIssue.mjs';

export const runtime = 'nodejs';

export const POST = createIssueRouteHandler({
    authenticate: getUser,
    createReport: createIssueReport,
    // Post-commit and best-effort: the report is already in audit_log with its
    // notification event by the time this runs. No-op unless TEAMS_* is set.
    onCreated: ({ report }) => notifyTeamsIssueReported({ report }),
});
