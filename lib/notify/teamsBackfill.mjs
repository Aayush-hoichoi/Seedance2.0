// Re-send Teams approval cards for requests that never got one.
//
// Cards are posted exactly once, at creation, best-effort: notifyTeams*Requested
// is fire-and-forget so a Microsoft outage can't fail the user's request. The
// cost of that choice is that a failed send was permanent — nothing retried, and
// the request stayed invisible to any admin who lives in Teams rather than the
// console. Production carried 10 pending model-access requests and 1 pending
// budget request with no card, and one of those was created two minutes AFTER
// the feature deployed: a genuinely lost send, not just pre-feature history.
//
// So this sweeps for pending requests with no card and sends one. Safe to run
// repeatedly: the senders upsert on (request_id, aad_object_id), and anything
// already carded is filtered out by the NOT EXISTS below.
//
// Every collaborator is injectable — the senders reach Microsoft, so tests
// supply stubs and this module stays network-free under `node --test`, the same
// shape lib/access/gatewaySync.mjs and the budget route handlers use.

import {
    loadAccessRequestPayload, notifyTeamsAccessRequested, teamsConfigured,
} from './teamsAccess.mjs';
import { loadBudgetRequestPayload, notifyTeamsBudgetRequested } from './teams.mjs';

// Bounds, so one sweep can't turn into a card flood in somebody's chat:
//   • age — a request pending for over a month is stale enough that a card
//     arriving now is noise; it belongs in the console.
//   • batch — caps the blast radius of a bad run, and the next sweep picks up
//     the remainder rather than sending everything at once.
const MAX_AGE_DAYS = 30;
const MAX_PER_RUN = 25;

export async function backfillTeamsCards({
    sql,
    loadAccess = loadAccessRequestPayload,
    sendAccess = notifyTeamsAccessRequested,
    loadBudget = loadBudgetRequestPayload,
    sendBudget = notifyTeamsBudgetRequested,
    isConfigured = teamsConfigured,
    maxAgeDays = MAX_AGE_DAYS,
    limit = MAX_PER_RUN,
} = {}) {
    // Without credentials every send would fail one by one and log noise; the
    // senders already no-op, but there is no point walking the tables.
    if (!sql || !isConfigured()) return { access: 0, budget: 0, skipped: true };

    const accessRows = await sql`SELECT r.id
        FROM model_access_requests r
        WHERE r.status IN ('pending', 'upgrade_pending')
          AND r.created_at > now() - (${maxAgeDays} || ' days')::interval
          AND NOT EXISTS (SELECT 1 FROM teams_access_cards c WHERE c.request_id = r.id)
        ORDER BY r.created_at
        LIMIT ${limit}`;

    // Budget requests live in audit_log: one `created` row, and at most one
    // decision row sharing its target_id (lib/budgetRequests.mjs). Pending means
    // no decision row yet.
    const budgetRows = await sql`SELECT a.target_id
        FROM audit_log a
        WHERE a.action = 'budget_request.created'
          AND a.created_at > now() - (${maxAgeDays} || ' days')::interval
          AND NOT EXISTS (SELECT 1 FROM audit_log d
              WHERE d.target_id = a.target_id
                AND d.action IN ('budget_request.approved', 'budget_request.denied'))
          AND NOT EXISTS (SELECT 1 FROM teams_budget_cards c WHERE c.request_id = a.target_id)
        ORDER BY a.created_at
        LIMIT ${limit}`;

    // Sequential on purpose: these share one bot token and one Graph resolver,
    // and a burst of parallel posts is what rate-limits the whole bot.
    // One failure must not strand the rest of the batch.
    let access = 0;
    for (const row of accessRows) {
        try {
            const request = await loadAccess(row.id, sql);
            if (!request) continue; // decided or deleted between the query and now
            await sendAccess({ requestId: row.id, request, sql });
            access += 1;
        } catch (err) {
            console.error(`[teams] backfill of access request ${row.id} failed:`, err?.message);
        }
    }

    let budget = 0;
    for (const row of budgetRows) {
        try {
            const request = await loadBudget(row.target_id, sql);
            if (!request) continue;
            await sendBudget({ requestId: row.target_id, request, sql });
            budget += 1;
        } catch (err) {
            console.error(`[teams] backfill of budget request ${row.target_id} failed:`, err?.message);
        }
    }

    if (access || budget) console.log(`[teams] backfilled ${access} access + ${budget} budget card(s)`);
    return { access, budget, skipped: false };
}
