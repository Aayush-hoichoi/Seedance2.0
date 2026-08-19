// Microsoft Teams model-access-approval cards — the same design as
// ../notify/teams.mjs (budget requests), applied to the second request type:
// a signed one-tap link instead of an inbound Bot Framework endpoint. See that
// file's header for the full rationale; this one only covers what's
// different about access requests.
//
// Model-access requests have no money dimension and, unlike budget requests,
// no audit_log snapshot of the request payload — the request's live row IS
// the payload, so `loadAccessRequestPayload` re-reads `model_access_requests`
// directly rather than replaying an audit trail.

import { getDb } from '../db/neon.js';
import { MODELS, IMAGE_MODELS } from '../seedance/constants.js';
import { signApprovalToken } from '../teams/magicLink.mjs';
import {
    appBase, approverEmails, approverRecipients, teamsConfigured, botToken, resolveAadObjectId,
    openConversation, postCard, replaceCard, header, linkAction, consoleAction,
} from '../teams/bot.mjs';

export { approverEmails, teamsConfigured };

function modelLabel(modelId) {
    const m = [...MODELS, ...IMAGE_MODELS].find((x) => x.id === modelId);
    return m ? m.name : (modelId || 'the model');
}

const accessConsoleAction = () => consoleAction('/console/users');

// --- cards -------------------------------------------------------------------

function factSet({ userEmail, projectName, modelId, maxResolution, pendingMaxResolution }) {
    const isUpgrade = pendingMaxResolution != null;
    return {
        type: 'FactSet',
        spacing: 'Medium',
        facts: [
            { title: 'User', value: userEmail || 'a member' },
            { title: 'Project', value: projectName || '—' },
            { title: 'Model', value: modelLabel(modelId) },
            {
                title: isUpgrade ? 'Quality' : 'Requested quality',
                value: isUpgrade ? `${maxResolution || 'any'} → ${pendingMaxResolution}` : (maxResolution || 'any'),
            },
        ],
    };
}

// The actionable card. Approve/Deny are plain links (see ../teams/magicLink.mjs)
// — same shape as the budget card: no Action.Execute, no invoke round-trip, no
// messaging endpoint. `links` omitted renders safely with no decision buttons.
export function buildAccessRequestCard(request, requestId, links = {}) {
    const isUpgrade = request.pendingMaxResolution != null;
    const body = [
        header(isUpgrade ? 'Quality upgrade request' : 'Model access request'),
        factSet(request),
    ];
    if (request.note) {
        body.push({
            type: 'Container', spacing: 'Medium',
            items: [
                { type: 'TextBlock', text: 'Note', weight: 'Bolder', size: 'Small', isSubtle: true, wrap: true },
                { type: 'TextBlock', text: request.note, wrap: true },
            ],
        });
    }
    const actions = [];
    if (links.approveUrl) actions.push(linkAction(isUpgrade ? 'Approve upgrade' : 'Approve', links.approveUrl, 'positive'));
    if (links.denyUrl) actions.push(linkAction(isUpgrade ? 'Deny upgrade' : 'Deny', links.denyUrl, 'destructive'));
    actions.push(...accessConsoleAction());
    return {
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.5',
        body,
        actions,
    };
}

// What every card becomes once the request is decided. No actions left — the
// decision is terminal.
export function buildAccessDecidedCard(request, decision) {
    const approved = decision?.status === 'approved';
    const upgradeDeclined = decision?.status === 'upgrade_declined';
    const title = approved ? 'Access approved' : upgradeDeclined ? 'Upgrade declined' : 'Access request denied';
    const body = [header(title, approved ? 'good' : 'attention')];
    if (approved) {
        body.push({
            type: 'TextBlock', spacing: 'Medium', wrap: true, size: 'ExtraLarge',
            weight: 'Bolder', color: 'Good', text: decision.maxResolution || 'Full quality',
        });
    }
    body.push(factSet(request));
    const trailer = [];
    const verb = approved ? 'Approved' : upgradeDeclined ? 'Declined' : 'Denied';
    if (decision?.decidedBy) trailer.push(`${verb} by ${decision.decidedBy}`);
    if (approved) trailer.push(decision?.expiresAt ? `until ${new Date(decision.expiresAt).toDateString()}` : 'no expiry');
    if (decision?.reason) trailer.push(`“${decision.reason}”`);
    if (trailer.length) {
        body.push({
            type: 'TextBlock', spacing: 'Medium', wrap: true, isSubtle: true, size: 'Small',
            text: trailer.join(' · '),
        });
    }
    return {
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.5',
        body,
        actions: accessConsoleAction(),
    };
}

// --- delivery ----------------------------------------------------------------

export async function notifyTeamsAccessRequested({ requestId, request, sql: providedSql = null }) {
    if (!teamsConfigured()) return null;
    const base = appBase();
    if (!base) {
        console.error('[teams] APP_URL (or NEXT_PUBLIC_APP_URL) is not set — cannot build approval links, skipping access-request send');
        return null;
    }
    try {
        const sql = providedSql ?? await getDb();
        if (!sql) return null;
        const token = await botToken();
        // An upgrade ask on a live grant is declined without touching that
        // grant (deny_upgrade); a plain not-yet-approved request is declined by
        // revoking it outright. The card's Deny link carries whichever is real.
        const denyAction = request.pendingMaxResolution != null ? 'deny_upgrade' : 'revoke';
        const results = await Promise.allSettled(approverRecipients().map(async ({ teamsEmail, appEmail }) => {
            // Two identities, resolved separately: appEmail authorises the
            // decision, teamsEmail receives the card. A recipient with no admin
            // account still gets the card — they asked to be told — but with no
            // approve/deny links, because a link is signed as a specific admin
            // and attributing their tap to someone else would put the wrong
            // name in the audit trail. The builder renders console-only actions
            // when no links are supplied.
            const [admin] = await sql`SELECT id, email, name FROM users
                WHERE lower(email) = ${appEmail} AND role = 'admin' AND deleted_at IS NULL LIMIT 1`;
            if (!admin) {
                console.warn(`[teams] ${teamsEmail} maps to ${appEmail}, which is not an admin in this app — `
                    + 'sending an informational card with no approve/deny. Give them an admin account, or map '
                    + 'the entry as teamsEmail=appAdminEmail in TEAMS_ADMIN_EMAILS.');
            }
            const aadObjectId = await resolveAadObjectId(teamsEmail);
            const conversationId = await openConversation(token, aadObjectId);
            const links = admin ? {
                approveUrl: `${base}/api/webhooks/teams-access-approve?token=${encodeURIComponent(
                    signApprovalToken({ kind: 'access', requestId, adminUserId: admin.id, aadObjectId, action: 'approve' }),
                )}`,
                denyUrl: `${base}/api/webhooks/teams-access-approve?token=${encodeURIComponent(
                    signApprovalToken({ kind: 'access', requestId, adminUserId: admin.id, aadObjectId, action: denyAction }),
                )}`,
            } : {};
            const card = buildAccessRequestCard(request, requestId, links);
            const activityId = await postCard(token, conversationId, card);
            await sql`INSERT INTO teams_access_cards
                (request_id, aad_object_id, conversation_id, activity_id, state)
                VALUES (${requestId}, ${aadObjectId}, ${conversationId}, ${activityId}, 'pending')
                ON CONFLICT (request_id, aad_object_id) DO UPDATE
                SET conversation_id = EXCLUDED.conversation_id,
                    activity_id = EXCLUDED.activity_id,
                    state = 'pending', updated_at = now()`;
            return activityId;
        }));
        for (const r of results) {
            if (r.status === 'rejected') console.error('[teams] access card send failed:', r.reason?.message || r.reason);
        }
        return { sent: results.filter((r) => r.status === 'fulfilled' && r.value).length, total: results.length };
    } catch (err) {
        console.error('[teams] access request notify failed:', err.message);
        return null;
    }
}

export async function updateTeamsAccessCards({ requestId, request, decision, skipAadObjectId = null, sql: providedSql = null }) {
    if (!teamsConfigured()) return null;
    try {
        const sql = providedSql ?? await getDb();
        if (!sql) return null;
        const rows = await sql`SELECT aad_object_id, conversation_id, activity_id
            FROM teams_access_cards WHERE request_id = ${requestId} AND state <> 'decided'`;
        const targets = rows.filter((r) => r.aad_object_id !== skipAadObjectId);
        if (!targets.length) return { updated: 0, total: 0 };
        const token = await botToken();
        const card = buildAccessDecidedCard(request, decision);
        const results = await Promise.allSettled(targets.map(async (row) => {
            await replaceCard(token, row.conversation_id, row.activity_id, card);
            await sql`UPDATE teams_access_cards SET state = 'decided', updated_at = now()
                WHERE request_id = ${requestId} AND aad_object_id = ${row.aad_object_id}`;
        }));
        for (const r of results) {
            if (r.status === 'rejected') console.error('[teams] access card update failed:', r.reason?.message || r.reason);
        }
        return { updated: results.filter((r) => r.status === 'fulfilled').length, total: targets.length };
    } catch (err) {
        console.error('[teams] access card update failed:', err.message);
        return null;
    }
}

export async function markTeamsAccessCardDecided({ requestId, aadObjectId, sql: providedSql = null }) {
    try {
        const sql = providedSql ?? await getDb();
        if (!sql) return;
        await sql`UPDATE teams_access_cards SET state = 'decided', updated_at = now()
            WHERE request_id = ${requestId} AND aad_object_id = ${aadObjectId}`;
    } catch (err) {
        console.error('[teams] access card state update failed:', err.message);
    }
}

// The request's live row IS the payload — there is no audit_log snapshot to
// replay, unlike budget requests. Re-reading it means a decided card's facts
// always reflect the request's actual current state.
export async function loadAccessRequestPayload(requestId, providedSql = null) {
    const sql = providedSql ?? await getDb();
    if (!sql) return null;
    const [row] = await sql`SELECT r.user_id AS "userId", r.user_email AS "userEmail", r.model_id AS "modelId",
            r.status, r.note, r.max_resolution AS "maxResolution", r.pending_max_resolution AS "pendingMaxResolution",
            r.project_id AS "projectId", p.name AS "projectName"
        FROM model_access_requests r LEFT JOIN projects p ON p.id = r.project_id
        WHERE r.id = ${requestId}`;
    return row ?? null;
}
