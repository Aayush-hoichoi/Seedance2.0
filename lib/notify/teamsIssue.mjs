// Microsoft Teams cards for generation issue reports, via the same HoichoiOS bot
// as ./teams.mjs. The transport (auth, conversation, post) is shared — see
// ../teams/bot.mjs; this file owns only the issue card shape.
//
// The card is INFORMATIONAL: it carries the error, the user, the project, the
// model and the attempt count, plus one "Open console" link. There is no
// Action.Execute here on purpose — triage happens in /console/issues, so there
// is no card state to keep in sync and nothing a preview crawler could decide.
//
// Best-effort throughout, exactly like ./teams.mjs and ./slack.mjs: unset
// TEAMS_* vars or any failed call logs and returns falsy. A Teams outage must
// never turn a successful issue report into an error the user sees.

import {
    appBase, approverIds, teamsConfigured, teamsMisconfigured, botToken, reportDelivery,
    openConversation, postCard, header, consoleAction,
} from '../teams/bot.mjs';

export { teamsConfigured };

// Adaptive Cards have no code block, so the raw provider error goes in a
// bordered container at Small size — legible, and visually not prose.
function errorBlock(title, value) {
    if (!value) return [];
    const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return [{
        type: 'Container', spacing: 'Medium', style: 'attention', bleed: false,
        items: [
            { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Small', isSubtle: true, wrap: true },
            { type: 'TextBlock', text: body.slice(0, 2000), wrap: true, size: 'Small', fontType: 'Monospace' },
        ],
    }];
}

// How many times the user actually pressed Generate, next to the retries the
// studio and the gateway performed on their behalf — three different numbers
// that all get called "attempts" in a bug report.
function attemptsText(attempts = {}) {
    const parts = [`${attempts.userRetries ?? 1} ${attempts.userRetries === 1 ? 'try' : 'tries'}`];
    if (attempts.submitAttempts > 1) parts.push(`${attempts.submitAttempts} submit retries`);
    if (attempts.serverAttempt > 1) parts.push(`gateway attempt ${attempts.serverAttempt}`);
    return parts.join(' · ');
}

export function buildIssueCard(report) {
    const body = [
        header('Generation issue', 'attention'),
        {
            type: 'TextBlock', spacing: 'Medium', wrap: true, size: 'Medium',
            weight: 'Bolder', color: 'Attention',
            text: (report.clientError || report.server?.error?.message || 'Generation failed.').slice(0, 300),
        },
        {
            type: 'FactSet',
            spacing: 'Medium',
            facts: [
                { title: 'User', value: report.userName || report.userEmail || 'a member' },
                { title: 'Project', value: report.projectName || '—' },
                { title: 'Model', value: report.modelName || report.modelId || '—' },
                { title: 'Attempts', value: attemptsText(report.attempts) },
                ...(report.modeId ? [{ title: 'Mode', value: report.modeId }] : []),
                ...(report.jobRef?.taskId ? [{ title: 'Task', value: report.jobRef.taskId }] : []),
                ...(report.server?.status ? [{ title: 'Job status', value: `${report.server.status} (job ${report.server.jobId})` }] : []),
            ],
        },
    ];
    if (report.note) {
        body.push({
            type: 'Container', spacing: 'Medium',
            items: [
                { type: 'TextBlock', text: 'What they were doing', weight: 'Bolder', size: 'Small', isSubtle: true, wrap: true },
                { type: 'TextBlock', text: report.note, wrap: true },
            ],
        });
    }
    // The provider's own error is the part that is actually debuggable, so it
    // goes on the card rather than behind the console link.
    body.push(...errorBlock('Provider error', report.server?.error));
    if (!report.server) {
        body.push({
            type: 'TextBlock', spacing: 'Small', isSubtle: true, size: 'Small', wrap: true,
            text: 'No gateway job row matched — the request likely failed before it reached a provider.',
        });
    }
    return {
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.5',
        body,
        actions: consoleAction('/console/issues', 'Open issues'),
    };
}

// Fan out to every configured admin; one failure must not stop the others.
export async function notifyTeamsIssueReported({ report }) {
    if (!teamsConfigured()) {
        if (teamsMisconfigured()) console.error('[teams] TEAMS_ADMIN_AAD_IDS is empty — no admin will be notified of issue reports');
        return null;
    }
    if (!appBase()) console.warn('[teams] APP_URL (or NEXT_PUBLIC_APP_URL) is not set — sending the issue card without a console link');
    try {
        const token = await botToken();
        const ids = approverIds();
        const card = buildIssueCard(report);
        const results = await Promise.allSettled(ids.map(async (aadObjectId) => {
            const conversationId = await openConversation(token, aadObjectId);
            return postCard(token, conversationId, card);
        }));
        return { sent: reportDelivery('issue report', ids, results), total: results.length };
    } catch (err) {
        console.error('[teams] issue report notify failed:', err.message);
        return null;
    }
}
