// Microsoft Teams workflow-access cards — the same send-and-update design as
// teamsAccess.mjs, applied to the third request type. Workflow access is ONE
// request per user (approval unlocks every workflow), so the requesting
// user_id is the request id everywhere, including the tracking table.
//
// Like its siblings: the card informs and links to the console; it never
// carries an Approve/Deny URL a link scanner could click.

import { getDb } from '../db/neon.js';
import {
    appBase, approverIds, teamsConfigured, teamsMisconfigured, botToken, reportDelivery,
    openConversation, postCard, replaceCard, header, consoleAction,
} from '../teams/bot.mjs';

const workflowConsoleAction = () => consoleAction('/console/requests');

// --- cards -------------------------------------------------------------------

function factSet({ userEmail, userId, note }) {
    const facts = [
        { title: 'User', value: userEmail || userId || 'a member' },
        { title: 'Scope', value: 'All workflows (one approval unlocks every workflow)' },
    ];
    if (note) facts.push({ title: 'Note', value: note });
    return { type: 'FactSet', spacing: 'Medium', facts };
}

export function buildWorkflowRequestCard(request) {
    return {
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.5',
        body: [
            header('Workflow access request'),
            {
                type: 'TextBlock', spacing: 'Small', wrap: true, isSubtle: true, size: 'Small',
                text: 'Workflows apply a show’s locked style to every generation. Decide on the Requests page.',
            },
            factSet(request),
        ],
        actions: workflowConsoleAction(),
    };
}

// What every card becomes once the request is decided — terminal, no actions
// beyond the console link.
export function buildWorkflowDecidedCard(request, decision) {
    const approved = decision?.status === 'approved';
    const body = [
        header(approved ? 'Workflow access approved' : 'Workflow access denied', approved ? 'good' : 'attention'),
        factSet(request),
    ];
    if (decision?.decidedBy) {
        body.push({
            type: 'TextBlock', spacing: 'Medium', wrap: true, isSubtle: true, size: 'Small',
            text: `${approved ? 'Approved' : 'Denied'} by ${decision.decidedBy}`,
        });
    }
    return {
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.5',
        body,
        actions: workflowConsoleAction(),
    };
}

// --- delivery ----------------------------------------------------------------

export async function notifyTeamsWorkflowRequested({ request, sql: providedSql = null }) {
    if (!teamsConfigured()) {
        if (teamsMisconfigured()) console.error('[teams] TEAMS_ADMIN_AAD_IDS is empty — no admin will be notified of workflow requests');
        return null;
    }
    if (!appBase()) console.warn('[teams] APP_URL (or NEXT_PUBLIC_APP_URL) is not set — sending the workflow card without a console link');
    try {
        const sql = providedSql ?? await getDb();
        if (!sql) return null;
        const token = await botToken();
        const ids = approverIds();
        const card = buildWorkflowRequestCard(request);
        const results = await Promise.allSettled(ids.map(async (aadObjectId) => {
            const conversationId = await openConversation(token, aadObjectId);
            const activityId = await postCard(token, conversationId, card);
            await sql`INSERT INTO teams_workflow_cards
                (user_id, aad_object_id, conversation_id, activity_id, state)
                VALUES (${request.userId}, ${aadObjectId}, ${conversationId}, ${activityId}, 'pending')
                ON CONFLICT (user_id, aad_object_id) DO UPDATE
                SET conversation_id = EXCLUDED.conversation_id,
                    activity_id = EXCLUDED.activity_id,
                    state = 'pending', updated_at = now()`;
            return activityId;
        }));
        return { sent: reportDelivery('workflow request', ids, results), total: results.length };
    } catch (err) {
        console.error('[teams] workflow request notify failed:', err.message);
        return null;
    }
}

export async function updateTeamsWorkflowCards({ request, decision, sql: providedSql = null }) {
    if (!teamsConfigured()) return null;
    try {
        const sql = providedSql ?? await getDb();
        if (!sql) return null;
        const rows = await sql`SELECT aad_object_id, conversation_id, activity_id
            FROM teams_workflow_cards WHERE user_id = ${request.userId} AND state <> 'decided'`;
        if (!rows.length) return { updated: 0, total: 0 };
        const token = await botToken();
        const card = buildWorkflowDecidedCard(request, decision);
        const results = await Promise.allSettled(rows.map(async (row) => {
            await replaceCard(token, row.conversation_id, row.activity_id, card);
            await sql`UPDATE teams_workflow_cards SET state = 'decided', updated_at = now()
                WHERE user_id = ${request.userId} AND aad_object_id = ${row.aad_object_id}`;
        }));
        for (const r of results) {
            if (r.status === 'rejected') console.error('[teams] workflow card update failed:', r.reason?.message || r.reason);
        }
        return { updated: results.filter((r) => r.status === 'fulfilled').length, total: rows.length };
    } catch (err) {
        console.error('[teams] workflow card update failed:', err.message);
        return null;
    }
}
