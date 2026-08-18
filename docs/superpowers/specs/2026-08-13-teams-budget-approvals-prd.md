# Budget Approvals in Microsoft Teams — PRD

**Date:** 2026-08-13
**Status:** SUPERSEDED by `2026-08-17-teams-budget-approvals-v2-prd.md`
**Owner:** LoglineAI Studio
**Depends on:** HoichoiOS Teams bot (`CortexAIBot`), reference doc dated 2026-08-04

## Goal

An admin can act on a budget request **from Teams** — approve it, deny it, or
change the amount first — without opening the console. A user asks for $5; the
admin can grant $3, or $10, and the studio's cap moves by exactly that.

This is a second **front door** onto an approval flow that already exists and is
already correct. It is not a second implementation of it.

## Why

Budget requests are the only approval flow in the product with **no external
notification at all**. Model-access requests and project requests both post to
Slack (`lib/notify/slack.mjs`); budget requests write an `events` row and stop.
An admin only learns about one by visiting `/console/budget-requests`.

The consequence is latency on a blocking action: a user hits their cap
mid-render and waits for an admin to happen to look. Teams is where these
admins already are.

## Non-goals

- Replacing the console. The console stays the source of truth and the only
  place with full context (live usage, spend history, the audit trail).
- A Teams surface for model-access or project requests. Those have Slack; this
  PRD is scoped to budget.
- Group/channel scope. The Teams app is registered `personal` only — 1:1 chats.
- Notifying requesters in Teams. They already get an in-app live notice.

## What already exists (verified 2026-08-13)

The bulk of this is done. Every row below was confirmed against live systems,
not assumed from documentation.

| Dependency | Status | Evidence |
|---|---|---|
| Editable-amount approval backend | Shipped | `decideBudgetRequest({ approvedAmount })`, PR #12 |
| Azure Bot `CortexAIBot` + app registration | Exists | Reference doc §1.1 |
| Teams app in org catalog (`com.hoichoi.hoichoios`) | Exists | Reference doc §4 |
| Client secret valid | Verified | token request → `200`, expires 3599s |
| Admin `2b436b3a-…` is a real identity | Verified | conversation → `201` |
| App installed for that admin | Verified | `201`, not `403 not installed` |
| Production URL reachable | Verified | `GET /` → `200` |
| `/api/webhooks/*` bypasses Clerk in prod | Verified | `POST /api/webhooks/teams` → `404`, not an SSO wall |
| Vercel Deployment Protection | Off | as above — request reached the app |

**The decision logic needs no changes.** `decideBudgetRequest` already accepts an
edited amount, enforces one-shot decisions under an advisory lock, records both
the requested and approved figures in `audit_log`, and notifies the requester —
all inside one transaction with the quota write and the access grant.

## External dependencies

Everything this feature relies on that does not live in this repository.

### 1. Microsoft Azure

| Dependency | Status | Needed by | Owner / access required |
|---|---|---|---|
| Azure Bot `CortexAIBot` (rg `HoichoiBrain`) | Exists | Phase 1 | HoichoiOS team |
| Entra app registration (App ID `d44207a8-…`) | Exists | Phase 1 | HoichoiOS team |
| Client secret for that app | Exists | Phase 1 | Secrets owner — see §Secrets below |
| Bot **messaging endpoint** set to this app | **Not set** | Phase 2 | Contributor on the bot resource |

### 2. Microsoft 365 / Teams

| Dependency | Status | Needed by | Owner / access required |
|---|---|---|---|
| Teams app in org catalog (`com.hoichoi.hoichoios`, personal scope) | Exists | Phase 1 | — |
| Each approving admin has **installed** the app | Verified for `2b436b3a-…`; per-admin thereafter | Phase 1 | The admin, or a Setup Policy |
| Teams admin center **Setup Policy** to auto-install for a group | Not configured | Phase 1 at scale | Teams Administrator role |

Org-catalog approval makes the app *available*, not installed. Until a given
admin adds it, `createConversation` returns
`403 Bot is not installed in user's personal scope`. Manual install is fine for
one or two admins; a Setup Policy is the only approach that scales.

### 3. Microsoft Graph permissions

| Permission | Status | Used by this design? |
|---|---|---|
| `User.Read.All` (Application) | Granted, admin-consented | **No** — recipients are configured by AAD object id |
| `TeamsAppInstallation.ReadWriteForUser.All` | **Not granted** | No — hence admins must self-install |

**This PRD requests no new Graph permission**, and no new admin consent cycle.
That removes what is usually the longest-lead external dependency.

### 4. Third-party services called at runtime

| Host | Purpose | Direction | Phase |
|---|---|---|---|
| `login.microsoftonline.com` | Client-credentials token | Outbound | 1 |
| `smba.trafficmanager.net` | Create conversation, post activity | Outbound | 1 |
| `login.botframework.com` | JWKS for inbound JWT verification | Outbound | 2 |
| Microsoft → this app | Card actions (`Action.Execute`) | **Inbound** | 2 |

Phase 1 is outbound-only: Microsoft never calls us, so there is no new inbound
attack surface until Phase 2. Availability of these hosts is a soft dependency —
by requirement 9, an outage degrades to "no Teams notification", never to a
failed budget request.

### 5. Hosting & network

| Dependency | Status | Notes |
|---|---|---|
| Public HTTPS endpoint | Verified — `GET /` → `200` | `https://seedance2-0-ruby.vercel.app` |
| `/api/webhooks/*` reachable without a session | Verified | `middleware.js` public-route allowlist |
| Vercel **Deployment Protection** off (or bypass token) | Verified off | If enabled later, Microsoft's POSTs hit an SSO wall and the route never runs — buttons fail silently with empty logs |
| **Stable production domain** | Current domain is the `.vercel.app` default | The endpoint is stored in Azure config; a domain change silently breaks every button |
| Node runtime (not Edge) on the webhook route | — | Phase 2 JWT verification needs Node crypto |
| `TEAMS_*` env vars in Vercel (Production + Preview) | **Not set** | Required before anything works when deployed — Phase 1 included |

### 6. Code dependencies

- **Phase 1: none.** `fetch` and JSON only; Adaptive Cards are plain JSON with no
  SDK. No Bot Framework SDK — the four REST calls are simpler than adopting it.
- **Phase 2: one.** A JWT/JWKS verifier. `jose` is already present in
  `node_modules` transitively via Clerk, but it is **not a declared dependency**
  and must be added to `package.json` explicitly rather than relied on by
  accident.

### 7. Organisational

| Dependency | Needed by | Why |
|---|---|---|
| Sign-off from the HoichoiOS bot owners | Phase 2 | One Azure Bot has one messaging endpoint; pointing it here couples two services. Their reference doc also states the bot is deliberately notify-only |
| Teams Administrator | Phase 1 at scale | Setup Policy for auto-install |
| Secrets owner | Phase 1 | Provide the client secret, own its rotation |

### Secrets

The client secret authenticates the only token path this design uses. It must
live in a secrets manager and in Vercel's environment variables — never in the
repository, a chat log, or a distributable document. Rotation is Entra →
App registrations → Certificates & secrets → New client secret, then update
every store before deleting the old one. Rotating invalidates outbound sends
immediately, so it needs an owner and a schedule.

### What this feature does *not* require

No new Azure resources. No new app registration. No manifest change or app
re-submission. No admin consent cycle. No new Graph permission. No queue,
worker, or cron. No conversation store. No schema change in Phase 1 (Phase 2
adds one nullable column). No new npm dependency in Phase 1.

## Users

| Role | Need |
|---|---|
| Admin | Decide a budget request in seconds, from a phone, with enough context not to be deciding blind |
| Requester | Unchanged — submits in the studio, gets the existing live notice with the granted amount |

## Requirements

### Functional

1. When a budget request is created, an Adaptive Card is delivered to every
   configured admin's 1:1 Teams chat.
2. The card shows: project, requester, models + quality tier, spend this month,
   current cap, requested increase, and the user's reason.
3. The admin can edit the amount on the card before approving.
4. The admin can choose hard or soft limit policy, and add an optional note.
5. Approve applies the edited amount; deny records the decision with the note.
6. After a decision the card is **replaced** with the outcome — it must not
   continue to look actionable.
7. When several admins are notified, the first decision wins; the others' cards
   show that it was already decided, and by whom.
8. A deep link to the console is always present, for anything the card can't
   answer.

### Non-functional

9. **Never blocks the request.** Notification is best-effort and post-commit. A
   Teams outage, an uninstalled app, a revoked secret — none may turn a
   successful budget request into an error the user sees.
10. **Authorization is two independent checks**, both required: a valid Bot
    Framework JWT (proves Microsoft sent it) *and* an AAD object id on the
    allowlist (proves an authorized admin sent it). Either alone is insufficient.
11. Every Teams decision is indistinguishable in the audit log from a console
    decision, except for the actor.
12. One admin's delivery failure must not suppress the others.

## Design

### Flow

```
user submits budget request (studio)                     [exists]
   │
   ├─→ audit_log + events row, one transaction           [exists]
   │
   └─→ notifyTeamsBudgetRequested()                      [Phase 1] best-effort
         ├─ token   scope api.botframework.com/.default
         ├─ POST /teams/v3/conversations       members:[<admin AAD id>]
         └─ POST /conversations/{id}/activities  + Adaptive Card

admin edits amount → Approve                             [Phase 2]
   └─→ POST /api/webhooks/teams
         ├─ verify Bot Framework JWT (login.botframework.com JWKS)
         ├─ assert from.aadObjectId ∈ TEAMS_ADMIN_AAD_IDS
         └─ decideBudgetRequest({ id, action, admin, approvedAmount, policy, reason })
               └─ return replacement card
```

### Why no Microsoft Graph call

Recipients are configured by **AAD object id**, so the reference doc's Step 1
(resolve a person by `displayName`) is not needed. Three consequences:

- Only one token scope is ever requested, removing the failure mode §1.2 of the
  reference doc calls out — the wrong scope does not error, it silently fails
  the next call.
- No `displayName` matching. This tenant hosts hoichoi, Sooper and LoglineAI
  across several verified domains, so a recorded `@hoichoi.tv` address can be an
  alias for a different sign-in identity. Fuzzy name matching is not an
  acceptable basis for deciding who may move money.
- `User.Read.All` becomes unused at runtime.

No conversation store is required either: each send opens a fresh conversation,
and the user sees one continuous chat regardless.

### Card

Adaptive Card 1.5 (the ceiling Teams renders reliably). Unsupported elements are
dropped silently rather than erroring, so the card must be tested as built
rather than trusted to a schema version.

Phase 1 is notify-only: facts plus `Action.OpenUrl` → console.
Phase 2 adds `Input.Number` (the editable amount), `Input.ChoiceSet` for policy,
`Input.Text` for the note, and `Action.Execute`.

`Action.Execute` rather than `Action.Submit` — Execute lets the handler return a
replacement card, which is what satisfies requirement 6.

### Files

| File | Phase | Change |
|---|---|---|
| `lib/notify/teams.mjs` | 1 | new — token, conversation, send, card builder |
| `lib/http/budgetRequestHandlers.mjs` | 1 | injected `onCreated` hook (keeps the module network-free under `node --test`) |
| `app/api/budget-requests/route.js` | 1 | wire the notifier |
| `app/api/webhooks/teams/route.js` | 2 | new — bot endpoint, `runtime = 'nodejs'` |
| `lib/teams/verify.mjs` | 2 | new — inbound JWT validation |
| `lib/db/schema.mjs` | 2 | `users.teams_aad_object_id` for exact-id mapping |

### Configuration

```
TEAMS_APP_ID=d44207a8-1004-49ef-93b3-73840cf51a75
TEAMS_TENANT_ID=13e520ef-9fca-4d6d-992f-6d604279cbe9
TEAMS_ADMIN_AAD_IDS=<comma-separated AAD object ids>
TEAMS_APP_PASSWORD=<client secret — secrets manager only>
```

Bot messaging endpoint (Phase 2, set in Azure once deployed):
`https://seedance2-0-ruby.vercel.app/api/webhooks/teams`

## Phases

**Phase 1 — Notification (~½ day).** Card delivered, decision still in the
console. No inbound endpoint, no new security surface. Stays within the existing
bot's documented design (reference doc §3.3: outbound-only, "keeps Teams a notify
surface, not an approval channel"), so it needs no architectural agreement from
the HoichoiOS owners. Useful on its own — it closes the notification gap.

**Phase 2 — Interactive approval (~2 days).** The endpoint, JWT verification,
identity mapping, editable card, replacement-card responses. Requires setting the
Azure messaging endpoint.

**Phase 3 — Multi-admin (~1 day).** Fan-out and already-decided rendering. The
backend already returns `decided` on a second attempt; only presentation is
missing.

## Testing

- Card builder is pure → unit-tested with no network, like the Slack builders.
- Route handlers keep their dependency-injection shape so `node --test` covers
  the notify hook without touching Teams.
- Phase 2: JWT verification tested against forged, expired, and wrong-audience
  tokens; authorization tested with a valid JWT from a non-allowlisted id.
- Manual: a real card to a real admin, on a real request.

## Risks & open decisions

| Risk | Mitigation |
|---|---|
| **Shared bot.** One Azure Bot has one messaging endpoint; pointing HoichoiOS's here means all its card actions arrive at this app | Handler ignores anything without a budget verb. Alternative: a separate Azure Bot for LoglineAI — cleaner, more setup |
| **Contradicts the documented design.** §3.3 states the bot is notify-only by design | Phase 1 respects it. Phase 2 needs a decision from the doc's author |
| **Deciding blind.** A card carries far less context than the console | Card shows spend-this-month and current cap; console link always present |
| **Override coupling.** Approving a budget currently overwrites deny overrides and widens quality grants — observed live: a $0.30 approval raised an admin's deliberate 720p grant to 1080p | **Fix before Phase 2.** A faster, easier approval surface fires this more often |
| **Admins must install the app.** Org-catalog approval makes it available, not installed; `createConversation` 403s until then | Teams admin center → Setup policy pushes it to a group |
| **Custom domain change** would silently break every button | Endpoint lives in Azure config; document it as a deploy dependency |
| **Secret handling.** Rotation invalidates both token paths at once | Entra → Certificates & secrets; rotate on a schedule and after any exposure |

## Success criteria

1. An admin decides a budget request end-to-end from Teams without opening the
   console, and the resulting cap matches the amount they typed on the card.
2. The audit row for a Teams decision carries both the requested and approved
   amounts, and is otherwise identical in shape to a console decision.
3. Turning off `TEAMS_*` config leaves budget requests working exactly as today.
4. Median time-to-decision on budget requests drops measurably.
