# PRD — "Report issue" on a failed generation

Status: draft · Author: derived from codebase investigation, 2026-08-27

## 1. Problem

When a generation fails in the studio the user sees a red tile with
`friendlyError(job.error)` (`app/seedance/SeedanceStudio.jsx:1794`) and nothing else
happens. The raw error, the model, the project, the task id and how many times they
retried all die in browser state. Today the user's only escalation is Slack/DM to an
admin, who then has to ask for all of that back.

## 2. Goal

One button on a failed generation. One tap sends the admin a card carrying the error
log, user, project, model and attempt count. Admin gets a live notification and a new
**Issues** tab in the console sidebar where the report can be triaged and closed.

Non-goals for v1: user-facing issue history/threading, file attachments, screenshots,
auto-retry, SLA timers, email digests.

## 3. What already exists (this is why it's cheap)

| Need | Existing thing | Path |
|---|---|---|
| Request ledger without a migration | `audit_log` used as an append-only request store (`budget_request.created` + one decision row) | `lib/budgetRequests.mjs:1-23,120-141` |
| Live admin notification | `events` outbox → SSE at `/api/events`; `eventVisibleTo` returns **true for every admin** | `app/api/events/route.js`, `lib/gateway/eventAudience.mjs:4-9` |
| Console toast + SWR revalidate on an event | `REVALIDATE` map + `useEvents('*')` | `app/console/ConsoleShell.jsx:36-86` |
| Sidebar tab with a pending-count badge | `Budget requests` nav entry + `pendingBudgetRequests` badge | `app/console/ConsoleShell.jsx:22-33,106-110` |
| Teams Adaptive Card to every admin | `openConversation` / `postCard` / `replaceCard` / `header` / `consoleAction` | `lib/teams/bot.mjs`, used by `lib/notify/teams.mjs` |
| Admin triage page + modal + cards | `BudgetRequestsClient` and `app/console/ui.jsx` primitives | `app/console/budget-requests/BudgetRequestsClient.jsx` |
| Route factory pattern (auth → validate → create → post-commit notify) | `createBudgetRequestRouteHandlers` | `lib/http/budgetRequestHandlers.mjs` |
| Server-side truth about the failure | `jobs` row per generation: `error` jsonb, `attempt`, `provider_task_id`, `request_body` | `lib/db/schema.mjs:168-190`, written in `lib/gateway/videoCreate.mjs:241` |

So: **no new table, no new transport, no new dependency.** New code is one lib module,
two routes, one modal, one console page, one nav entry, one card builder.

## 4. User stories

1. **As a studio user**, when my generation fails I click *Report issue* on the error
   tile, optionally type what I was trying to do, and hit send. I get a confirmation
   notice and go back to work.
2. **As an admin**, I get a Teams card within seconds showing user, project, model,
   attempt count and the error, and a live toast + badge in the console.
3. **As an admin**, I open `/console/issues`, read the full log, and mark the report
   *Resolved* or *Dismissed* with a note.

## 5. Scope

### 5.1 The button

Two placements, both cheap:

- **Primary** — on the failure tile in `BigStage` (`SeedanceStudio.jsx:1793-1797`), next
  to the error text. This is where the user actually is when it breaks.
- **Secondary** — on each errored card in the right-hand history rail, so a failure from
  five minutes ago is still reportable.

Both open one modal: `app/seedance/IssueReportModal.jsx`, styled exactly like
`BudgetRequestModal.jsx` (portal, `z-[210]`, escape-to-close, read-only context fields +
one optional textarea). Fields:

| Field | Source | Editable |
|---|---|---|
| Project | `projects.find(p => p.id === projectId).name` | no |
| User | Clerk user (server-side, from the session) | no |
| Model | `job.model` | no |
| Attempts | see §5.3 | no |
| Error | `job.error` raw, with `friendlyError()` shown above it | no |
| What were you doing? | user | yes, optional, 500 chars |

### 5.2 What "error logs" means

The client already holds everything the failure produced. Payload posted to
`POST /api/issues`:

```js
{
  projectId,
  jobRef: { taskId: job.taskId, genId: job.genId, mediaType: job.mediaType },
  modelId: job.model,
  attempts: <see 5.3>,
  error: job.error,                 // raw string, un-prettified
  modeId: job.modeId,               // motion_capture / t2v / image / ...
  options: job.options,             // resolution, duration, ratio, audio, seed
  prompt: job.prompt,               // truncated to 1000 chars
  note: <user text>,
  clientAt: job.createdAt,
}
```

**Server-side enrichment (this is the part that makes the card actually useful).**
Before writing the report, look up the `jobs` row — `WHERE provider_task_id = taskId`
for video, `WHERE id = genId` for image, both scoped to the requesting user — and attach
`jobs.error`, `jobs.status`, `jobs.attempt`, `jobs.provider_id`, `jobs.request_body`.
That is the provider's real error object, which the browser never sees. If no row is
found (e.g. the request never reached the gateway) the client payload stands alone and
the card says so.

The client payload is untrusted input: `projectId` is re-checked against
`project_memberships` exactly like `requestContext()` does
(`lib/budgetRequests.mjs:40-44`), and every string is length-clamped before storage.

### 5.3 "Number of try"

Two numbers, both already available, both shown:

- **Submit attempts** — `launchJob`'s rate-limit retry loop already counts 1..6
  (`SeedanceStudio.jsx:946-968`). Today it is a local `for` variable; persist it onto the
  job via the existing `patchJob(job.id, { attempts: attempt })` so the report can carry
  it. Plus `jobs.attempt` from the server row.
- **User retries** — how many jobs in this project share this job's `prompt` + `model`.
  Computed client-side from the rail (`jobs` state) at report time. This is what the
  user means by "I tried 4 times".

Card shows: `Attempts · 4 user retries · 2 submit retries`.

### 5.4 Storage — `audit_log`, no migration

Mirrors `createBudgetRequest` exactly:

- `action: 'issue.reported'`, `target_type: 'issue'`, `target_id: <uuid>`,
  `after: <payload jsonb>`, `actor_id/actor_email: reporter`.
- Decision row: `action: 'issue.resolved' | 'issue.dismissed'`, same `target_id`,
  `reason: <admin note>`.
- Status is derived by the same `LEFT JOIN LATERAL` shape as `listBudgetRequests`
  (`lib/budgetRequests.mjs:146-172`): no decision row → `open`.

Written in **one transaction** with the `events` insert, same as budget requests — if the
notification row can't be written, the report isn't recorded either and the user can
retry. New module: `lib/issueReports.mjs` exporting `createIssueReport`,
`listIssueReports`, `decideIssueReport`, `canReviewIssues` (`user.role === 'admin'`).

### 5.5 Notification

Three surfaces, all existing:

1. **SSE toast** — event type `issue.reported`, payload
   `{ issueId, projectName, userName, modelId, attempts, errorSummary }`. Because the
   event carries `user_id`, `eventVisibleTo` keeps it private to the reporter *and*
   every admin — non-admin colleagues never see it. Add to `REVALIDATE`:
   `'issue.reported': ['/api/admin/issues']` and a `toast(..., { icon: '🐞' })` in
   `ConsoleShell`.
2. **Sidebar badge** — same `useApi` + `.filter(status === 'open').length` pattern as
   `pendingBudgetRequests`.
3. **Teams card** — new `lib/notify/teamsIssue.mjs`, importing the transport from
   `lib/teams/bot.mjs`. Card body: `header('Generation issue', 'attention')`, the
   friendly error as the headline, a `FactSet` of User / Project / Model / Attempts /
   Task id, a monospace-ish container with the raw provider error, the user's note, and
   a single `consoleAction('/console/issues')` button. **No `Action.Execute` in v1** — the
   card is informational, triage happens in the console. That deliberately skips the
   `teams_*_cards` state table and the webhook `VERBS` entry.

   Best-effort throughout, same as budget: `if (!teamsConfigured()) return null`, wrapped
   in try/catch, called post-commit from the route's `onCreated`. A Teams outage must
   never turn a successful report into a user-visible error.

Slack (`lib/notify/slack.mjs`) is wired for access/project requests only. Out of scope
for v1; the card builder is a pure function so adding a Slack twin later is a small diff.

### 5.6 Console — `/console/issues`

- Nav entry: `{ href: '/console/issues', label: 'Issues', icon: Bug }` (lucide `Bug`),
  admin-only — no `managerOk`, so the existing manager bounce in `ConsoleShell:65-71`
  covers it for free.
- `app/console/issues/page.jsx` + `IssuesClient.jsx`, built from `app/console/ui.jsx`
  primitives (`PageHeader`, `Card`, `Badge`, `Modal`, `EmptyState`, `Field`).
- Layout: **Open · N** section then **History**, identical to `BudgetRequestsClient`.
- Card front: project, user + email, `Badge` tone amber/green/grey, `Detail` grid for
  Model / Attempts / Reported at / Task id, the user's note, and the error in a
  `font-mono text-xs` box with `max-h-40 overflow-y-auto` (provider errors get long).
- Actions on an open issue: **Resolve** and **Dismiss**, each opening a `Modal` with an
  optional note, posting to `/api/admin/issues/:id/:action`.

## 6. API surface

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/api/issues` | POST | any signed-in member of the project | Creates the report, then `onCreated` → Teams. Returns `201 { ok, id }`. |
| `/api/admin/issues` | GET | `canReviewIssues` | `{ issues: [...] }`, open first. |
| `/api/admin/issues/[id]/[action]` | POST | `canReviewIssues` | `action ∈ resolve\|dismiss`; 409 on a second decision (one-shot guard, same `NOT EXISTS` pattern as budgets). |

All under the existing Clerk middleware — none of them go in `isPublicRoute`.

Rate limit: one report per `(user, taskId)` — a `NOT EXISTS` guard on
`target_type='issue' AND after->'jobRef'->>'taskId' = $1 AND actor_id = $2` inside the
insert. Cheap, and it stops a frustrated user sending twelve identical cards. A user who
genuinely hits the same failure on a *new* attempt gets a new taskId, so a new report.

## 7. Files touched

New:
- `lib/issueReports.mjs`
- `lib/notify/teamsIssue.mjs`
- `app/api/issues/route.js`
- `app/api/admin/issues/route.js`
- `app/api/admin/issues/[id]/[action]/route.js`
- `app/seedance/IssueReportModal.jsx`
- `app/console/issues/page.jsx`, `app/console/issues/IssuesClient.jsx`
- `tests/issueReport.test.mjs`

Modified:
- `app/console/ConsoleShell.jsx` — nav entry, badge, `REVALIDATE`, toast
- `app/seedance/SeedanceStudio.jsx` — persist `attempts` on the job, modal state, button
  on the failure tile
- `app/seedance/HistoryRail`-side card (same file) — secondary button

Not touched: `lib/db/schema.mjs`, `middleware.js`, `app/api/webhooks/teams/route.js`,
`package.json`.

## 8. Tests

Following the repo's convention (`node --test tests/*.test.mjs`, pure functions with an
injected `sql` stub — see `tests/budgetRequestWorkflow.test.mjs`):

- `createIssueReport` writes exactly one `issue.reported` row + one `events` row in one
  transaction, and rejects a non-member `projectId`.
- `listIssueReports` derives `open` / `resolved` / `dismissed` from the decision row.
- `decideIssueReport` is one-shot: a second decision returns `{ error: 'decided' }`.
- The duplicate guard: two reports for the same `taskId` by the same user → one row.
- `buildIssueCard` is a pure builder — asserted against a fixture with no network,
  including the "no server job row found" branch.

## 9. Rollout / config

Zero new environment variables. Teams delivery reuses `TEAMS_APP_ID`,
`TEAMS_APP_PASSWORD`, `TEAMS_TENANT_ID`, `TEAMS_ADMIN_AAD_IDS`, `APP_URL`. With those
unset the feature still works end-to-end: report is stored, SSE toast fires, the Issues
tab fills. Only the Teams card is skipped.

## 10. Open questions

1. **Should admins be able to resolve from the Teams card?** v1 says no (informational
   card, console triage). Adding it later means a `teams_issue_cards` table and a
   `VERBS` entry in the webhook — a real but contained diff. Say the word and it goes in
   v1 instead.
2. **Should the reporter be notified when an issue is resolved?** The `events` plumbing
   makes this ~5 lines (an `issue.resolved` event scoped to `user_id`, a toast in the
   studio). Currently out of scope.
3. **Prompt in the payload — privacy.** Prompts are already visible to admins via the
   ledger (`/console/ledger`), so including it is consistent. Flagging it explicitly
   rather than assuming.
4. **Manual reports for non-failures?** The button is bound to a failed job. A generic
   "something's wrong" button with no job attached is a different feature; not included.
