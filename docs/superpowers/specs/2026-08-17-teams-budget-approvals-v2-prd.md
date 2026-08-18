# Budget Approvals in Microsoft Teams — PRD v2

**Date:** 2026-08-17
**Status:** Proposed — not started
**Supersedes:** `2026-08-13-teams-budget-approvals-prd.md` (notify-only scope)
**Owner:** LoglineAI Studio
**Depends on:** HoichoiOS Teams bot (`CortexAIBot`), reference doc dated 2026-08-04

---

## 1. Goal

When a user requests budget from a project workspace, an **actionable card** arrives in each admin's Microsoft Teams inbox alongside the existing console entry. The admin can **approve, edit the amount, or deny** from that card, and the outcome is real: the user's cap moves by exactly the approved amount and they can generate against it immediately.

The console and Teams are two windows onto **one decision**. Whichever surface acts first, the other reflects it.

## 2. Why

Budget requests are the only approval flow in the product with **no external notification**. Model-access and project requests both post to Slack (`lib/notify/slack.mjs`); budget requests write an `events` row and stop. An admin learns about one only by visiting `/console/budget-requests`.

That latency lands on a blocking action. A user hits their cap mid-render and waits. On 2026-08-13 a user submitted five generations against a $0.30 cap, each rejected before reaching the provider, while the approval sat unseen in a console nobody had open.

## 3. Scope

**In scope**
- Adaptive Card to each configured admin on request creation
- Approve / deny / **edit the amount** from the card
- Bidirectional state reflection between Teams and the console
- Multi-admin fan-out with first-decision-wins

**Out of scope**
- Replacing the console. It remains the source of truth and the only surface with full context (live usage, spend history, audit trail).
- Teams surfaces for model-access or project requests (those have Slack).
- Group/channel scope — the Teams app is registered `personal` only.
- Teams notifications to requesters. They already get an in-app live notice.
- Any change to how budgets are computed, reserved, or enforced.

---

## 4. What already exists

The feature is mostly assembly. Every row below was verified against live systems.

| Dependency | Status | Evidence |
|---|---|---|
| Editable-amount approval backend | **Shipped** | `decideBudgetRequest({ approvedAmount })`, PR #12 |
| One-shot decision guard | **Shipped** | advisory lock + `NOT EXISTS` guard, returns `error: 'decided'` |
| Audit of requested vs approved | **Shipped** | `approvedIncrease`, `requestedIncrease`, `amountAdjusted` |
| Console live-refresh on decision | **Shipped** | `ConsoleShell.jsx:41` revalidates on the SSE event |
| Every card field | **Available** | see §6.1 — all in the request payload already |
| Azure Bot + app registration | Exists | reference doc §1.1 |
| Teams app in org catalog | Exists | `com.hoichoi.hoichoios`, personal scope |
| Client secret | Verified | token request → `200` |
| Admin `2b436b3a-…` reachable | Verified | `createConversation` → `201` (not `403`) |
| Production endpoint reachable | Verified | `POST /api/webhooks/teams` → `404`, not an SSO wall |
| Deployment Protection | Off | as above |

**No decision logic is added.** `decideBudgetRequest` already applies an edited amount, enforces one-shot semantics under an advisory lock, writes the quota, grants model access, records the audit row, and emits the notification event — all in one transaction. Teams becomes a second caller of that function and nothing more. This is the single most important constraint in this document: **two surfaces, one code path.**

---

## 5. Core concepts

### 5.1 The server is the only source of truth

A card is a **projection** of `audit_log`, never a copy of it. Cards can go stale — a network failure, an expired activity, an admin whose Teams client is offline. That is tolerable because **every action re-validates server-side before anything happens.**

A stale card showing "pending" for an already-decided request cannot cause a double approval: `decideBudgetRequest` returns `error: 'decided'`, and the handler replaces the card with the real outcome. **The staleness heals itself at the moment it would matter.**

This is what makes the bidirectional sync robust without distributed transactions, queues, or reconciliation jobs.

### 5.2 The two directions are not symmetrical

**Teams → console: already works.** A Teams decision calls `decideBudgetRequest`, which inserts a `budget.request.approved` row into `events` in the same transaction. The console's SSE stream delivers it and `ConsoleShell` revalidates `/api/admin/budget-requests` and the quotas endpoint. **Zero new code.**

**Console → Teams: the real work.** Teams has no subscription model. To update a card you must call the Connector API with the **conversation id and activity id** of the message you sent. Those must be persisted at send time — the notify-only design in v1 explicitly did not need this, and that is the main architectural difference in v2.

### 5.3 First decision wins, everyone sees it

`decideBudgetRequest` serialises concurrent decisions on `pg_advisory_xact_lock(hashtext('budget-request:<id>'))`. The first commits; every other caller sees the `NOT EXISTS` guard fail and receives `decided`. Two admins tapping Approve simultaneously — one from Teams, one from the console — is already safe today.

What's missing is only **presentation**: the losing admin should see "already approved by Rachit — $30.00" rather than a silent failure.

---

## 6. Requirements

### 6.1 The card

Content, exactly as specified — and every field is already in the payload written by `createBudgetRequest`, so the card needs no additional queries:

| Card field | Source |
|---|---|
| User name | `payload.userName` (falls back to email) |
| Project name | `payload.projectName` |
| Model name | `payload.modelName` (`"All models"` for `*`) |
| Required budget | `payload.increaseAmount` |
| **User's spent budget** | `payload.spent` — settled + failed this month |
| **Total allotted budget** | `payload.currentLimit` — `null` renders "No personal limit" |
| Quality tier | `payload.quality` |
| Reason | `payload.reason` |

Plus, for a decision made without console access:
- an **editable amount** field, prefilled with the requested figure
- a **hard/soft policy** choice
- an optional **decision note**
- **Approve** and **Deny** actions
- a link to the console for anything the card can't answer

### 6.2 Functional

1. On request creation, a card is delivered to every configured admin's 1:1 chat.
2. The admin may change the amount before approving; the approved cap moves by that amount, not the requested one.
3. Approving from Teams produces a quota change, model grant, audit row and requester notification **identical** to a console approval, differing only in the recorded actor.
4. Denying from Teams records the decision and notifies the requester.
5. After any decision, the acting admin's card is **replaced** with the outcome.
6. Other admins' cards are updated to show the request was decided, by whom, and for how much.
7. A decision made in the **console** updates all Teams cards.
8. A decision made in **Teams** updates the console live (existing SSE path).
9. Acting on a stale card never double-decides — it renders the real outcome instead.
10. The user's approved budget is immediately usable — no extra step, no re-sync.

### 6.3 Non-functional

11. **Never blocks the request.** Card delivery is post-commit and best-effort. Teams being down must not turn a successful budget request into a user-visible error.
12. **Authorization is two independent checks**, both required: a valid Bot Framework JWT *and* an AAD object id mapped to an admin. Either alone is insufficient.
13. Identity is matched by **exact AAD object id**, never by name or email (§9.2).
14. A card that fails to send or update is a logged degradation, never a state divergence.
15. Turning off the `TEAMS_*` configuration returns the system to exactly today's behaviour.

---

## 7. Design

### 7.1 Sequence — request

```
user submits budget request (studio)
  │
  ├─ audit_log 'budget_request.created' + events 'budget.requested'   [ONE TRANSACTION, exists]
  │
  └─ notifyTeamsBudgetRequested(requestId, payload)      [NEW · post-commit · best-effort]
       ├─ bot token   (scope api.botframework.com/.default)
       └─ for each admin id:
            ├─ POST /v3/conversations                    → conversationId
            ├─ POST /v3/conversations/{cid}/activities   → activityId
            └─ INSERT teams_budget_cards(request_id, aad_id, cid, activityId, 'pending')
```

### 7.2 Sequence — decision from Teams

```
admin edits amount → taps Approve
  │
  └─ POST /api/webhooks/teams                            [NEW]
       ├─ verify Bot Framework JWT                       → else 401
       ├─ map from.aadObjectId → admin user, role check  → else 403
       ├─ decideBudgetRequest({ id, action, admin, approvedAmount, policy, reason })
       │     └─ quota + grant + audit + events           [ONE TRANSACTION, exists]
       ├─ invoke response: replace the acting admin's card with the outcome
       └─ fan-out: PUT the other admins' cards → "already decided"
             │
             └─ console updates itself from the events row (existing SSE)
```

### 7.3 Sequence — decision from the console

```
admin approves in /console/budget-requests
  │
  ├─ decideBudgetRequest(…)                              [exists, unchanged]
  │
  └─ onDecided hook                                      [NEW]
       └─ for each row in teams_budget_cards(request_id):
            PUT /v3/conversations/{cid}/activities/{aid}  → outcome card
```

### 7.4 State machine (per request)

```
                 ┌─────────┐
   created ────► │ pending │
                 └────┬────┘
        approve/deny  │  (whichever surface acts first)
                 ┌────▼────┐
                 │ decided │ ── terminal, enforced by advisory lock + NOT EXISTS guard
                 └─────────┘

card states: sent → updated(decided) → [stale] ── heals on next tap
```

There is no `approving` intermediate state and no compensating transaction, because the decision is a single atomic commit. Cards trail that commit; they never lead it.

### 7.5 Data

One new table. It exists to make cards **updatable** and **idempotent** — not to hold state that matters to the decision.

```sql
CREATE TABLE IF NOT EXISTS teams_budget_cards (
    id              serial PRIMARY KEY,
    request_id      uuid    NOT NULL,          -- audit_log.target_id
    aad_object_id   text    NOT NULL,          -- recipient admin
    conversation_id text    NOT NULL,
    activity_id     text    NOT NULL,
    state           text    NOT NULL DEFAULT 'pending',   -- pending | decided | failed
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (request_id, aad_object_id)          -- one card per admin per request
);
```

Plus one column for inbound identity:

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS teams_aad_object_id text UNIQUE;
```

Both follow the existing `getDb()` bootstrap-chain pattern in `lib/db/neon.js` — no migration tooling required.

### 7.6 Card mechanics

- **Adaptive Card 1.5.** Teams silently drops unsupported elements rather than erroring, so the card must be tested as built.
- **`Action.Execute`, not `Action.Submit`.** Execute allows the handler to return a replacement card in the invoke response, which is what satisfies requirement 5. Submit cannot.
- **Updating other admins' cards** uses `PUT /v3/conversations/{conversationId}/activities/{activityId}` with the outcome card.
- **`Input.Number`** carries the editable amount; its value arrives merged into the action data.
- Keep the payload light — a base64 icon is convenient but adds real size to every send.

### 7.7 Files

| File | Change |
|---|---|
| `lib/notify/teams.mjs` | **new** — token cache, conversation, send, update, card builders |
| `lib/teams/verify.mjs` | **new** — inbound JWT validation against the Bot Framework JWKS |
| `lib/teams/identity.mjs` | **new** — AAD object id → admin user, with role assertion |
| `app/api/webhooks/teams/route.js` | **new** — bot endpoint, `runtime = 'nodejs'` |
| `lib/http/budgetRequestHandlers.mjs` | injected `onCreated` / `onDecided` hooks (keeps the module network-free under `node --test`) |
| `app/api/budget-requests/route.js` | wire `onCreated` |
| `app/api/admin/budget-requests/[id]/[action]/route.js` | wire `onDecided` |
| `lib/db/neon.js` | the two DDL statements above |

Hooks are **injected, not imported**, so the HTTP layer stays network-free in tests — the same dependency-injection shape the existing handlers already use.

---

## 8. External dependencies

Everything the feature relies on that does not live in this repository.

### 8.1 Microsoft Azure

| Dependency | Status | Needed by | Access required |
|---|---|---|---|
| Azure Bot `CortexAIBot` (rg `HoichoiBrain`) | Exists | send | HoichoiOS team |
| Entra app registration `d44207a8-…` | Exists | send | HoichoiOS team |
| Client secret | Exists, verified | send | secrets owner |
| **Messaging endpoint** → `https://<prod>/api/webhooks/teams` | **Not set** | **actions** | Contributor on the bot resource |

The messaging endpoint is the single Azure change this feature requires. **One Azure Bot has exactly one endpoint**, which is the coupling decision in §10.

### 8.2 Microsoft 365 / Teams

| Dependency | Status | Needed by | Access required |
|---|---|---|---|
| Teams app in org catalog (`com.hoichoi.hoichoios`, personal scope) | Exists | send | — |
| Each approving admin has **installed** the app | Verified for one admin | send | the admin, or a Setup Policy |
| Teams **Setup Policy** for auto-install | Not configured | scale | Teams Administrator |

Org-catalog approval makes the app *available*, not installed. Until an admin adds it, `createConversation` returns `403 Bot is not installed in user's personal scope`. Manual install is fine for two or three admins; a Setup Policy is the only approach that scales.

### 8.3 Microsoft Graph

| Permission | Status | Used? |
|---|---|---|
| `User.Read.All` (Application) | Granted, consented | **No** — recipients are configured by AAD object id |
| `TeamsAppInstallation.ReadWriteForUser.All` | Not granted | No — hence admins self-install |

**This PRD requests no new Graph permission and no new admin-consent cycle** — usually the longest-lead external dependency.

### 8.4 Services called at runtime

| Host | Purpose | Direction | Failure impact |
|---|---|---|---|
| `login.microsoftonline.com` | client-credentials token | outbound | no card sent; console unaffected |
| `smba.trafficmanager.net` | create conversation, post/update activity | outbound | card missing or stale; heals on tap |
| `login.botframework.com` | JWKS for inbound JWT | outbound | actions rejected (fail closed) |
| Microsoft → this app | card actions | **inbound** | — |

JWKS should be cached with a TTL; fetching per request adds latency to every decision and makes Microsoft's availability a hard dependency of approving budget.

### 8.5 Hosting & network

| Dependency | Status | Note |
|---|---|---|
| Public HTTPS endpoint | Verified | `https://seedance2-0-ruby.vercel.app` |
| `/api/webhooks/*` bypasses Clerk | Verified | `middleware.js:8` allowlist |
| Vercel **Deployment Protection** off (or bypass token) | Verified off | If enabled later, Microsoft's POSTs hit an SSO wall, the route never runs, and buttons fail silently with empty logs |
| **Stable production domain** | `.vercel.app` default today | The endpoint is stored in Azure config — a domain change silently breaks every button |
| Node runtime on the webhook route | — | JWT verification needs Node crypto |
| `TEAMS_*` env vars in Vercel | **Not set** | Required in Production *and* Preview |

### 8.6 Code dependencies

- **Sending:** none. `fetch` and JSON; Adaptive Cards are plain JSON. No Bot Framework SDK — four REST calls are simpler than adopting it.
- **Receiving:** one JWT/JWKS verifier. **`jose` is present in `node_modules` transitively via Clerk but is not a declared dependency** — it must be added to `package.json` explicitly rather than relied on by accident.

### 8.7 Organisational

| Dependency | Needed by | Why |
|---|---|---|
| Sign-off from HoichoiOS bot owners | actions | Shared endpoint; their doc states the bot is deliberately notify-only |
| Teams Administrator | scale | Setup Policy |
| Secrets owner | send | Provide and rotate the client secret |

### 8.8 Secrets

The client secret authenticates the only token path used. It belongs in a secrets manager and Vercel env — never in the repository, a chat log, or a distributable document. Rotation: Entra → App registrations → Certificates & secrets → new secret → update every store → delete the old one. **Rotation invalidates sending immediately**, so it needs an owner and a schedule.

### 8.9 Not required

No new Azure resources. No new app registration. No manifest change or re-submission. No admin-consent cycle. No new Graph permission. No queue, worker or cron. No change to budget computation, reservation or enforcement.

---

## 9. Security

### 9.1 Two independent gates

The endpoint is public by necessity. Both checks are mandatory:

1. **JWT** — signature valid against `login.botframework.com/v1/.well-known/keys`, issuer `https://api.botframework.com`, audience = the App ID, not expired. Proves Microsoft sent it.
2. **Identity** — `activity.from.aadObjectId` maps to a user with `role = 'admin'`. Proves an authorized person sent it.

Without (1), anyone who finds the URL can approve budgets. Without (2), any user in the tenant can. This mirrors the Slack handler, which authenticates by signing secret rather than session.

### 9.2 Never match by name or email

The reference doc resolves recipients by `displayName` because hoichoi / Sooper / LoglineAI share one tenant across several verified domains, so a recorded `@hoichoi.tv` address can be an alias for a different sign-in identity.

**That is acceptable for addressing a message and unacceptable for authorizing one.** Inbound identity must be an exact `teams_aad_object_id` match. An unmapped id is rejected, never fuzzy-matched.

### 9.3 Ignore foreign activities

One Azure Bot, one endpoint: HoichoiOS's other cards will arrive here. The handler must ignore any activity without a recognised budget verb — silently and with a 200, so Microsoft doesn't retry.

---

## 10. Risks & decisions

| Risk | Mitigation |
|---|---|
| **Shared bot.** Pointing HoichoiOS's endpoint here routes all its card actions to this app | Ignore unknown verbs (§9.3). Alternative: a separate Azure Bot for LoglineAI — cleaner, more setup. **Decision needed before Phase 2** |
| **Contradicts the documented design.** The reference doc states the bot is notify-only and "keeps Teams a notify surface, not an approval channel" | Phase 1 respects it; Phase 2 needs the doc author's agreement |
| **Deciding blind.** A card carries less context than the console | The card shows spent and total allotted budget (§6.1) — the two numbers that make an amount judgeable — plus a console link |
| **Card/DB divergence** | Structurally impossible to cause harm: every action re-validates and the decision is one-shot (§5.1) |
| **Stale `activity_id`** (message deleted, chat cleared) | Update fails, logged; card heals on next tap |
| **Custom domain change** | Silently breaks every button. Document the endpoint as a deploy dependency |
| **Approval fatigue on a phone** | The amount is editable, not just yes/no, so the fast path is still a considered decision |
| **Override coupling.** Approving a budget currently overwrites deny overrides and widens quality grants — observed live: a $0.30 approval widened a deliberate 720p grant to 1080p | **Fix before Phase 2.** A faster approval surface fires this more often |

---

## 11. Phasing

| Phase | Scope | Effort | External blocker |
|---|---|---|---|
| **1 — Notify** | Card delivered; `Action.OpenUrl` → console. Persists `teams_budget_cards` from day one so Phase 2 needs no backfill | ~1 day | none |
| **2 — Act** | Endpoint, JWT, identity mapping, editable amount, `Action.Execute`, replacement card | ~2 days | messaging endpoint; bot-owner sign-off |
| **3 — Sync** | `onDecided` hook updates all cards; multi-admin fan-out; "already decided by X" | ~1 day | none |

Phase 1 is independently useful — it closes the notification gap — and stays inside the existing bot's documented design, so it can ship while the Phase 2 decisions are still being discussed.

---

## 12. Testing

**Unit (no network)** — card builders are pure functions, like the Slack builders. Assert every field in §6.1 renders, including `currentLimit = null` → "No personal limit".

**Route handlers** — keep the dependency-injection shape so `node --test` covers the hooks with a stub notifier.

**Security** — forged signature, expired token, wrong audience, valid JWT from a non-allowlisted id, and an activity with an unknown verb.

**Concurrency** — two decisions on one request (console + Teams) commit exactly one; the loser sees `decided`.

**Amount integrity** — an edited amount from Teams produces the same quota arithmetic as the console path, including the minimum-safe-cap floor.

**Manual** — a real card to a real admin on a real request; approve from Teams and confirm the console updates without a refresh; approve from the console and confirm the Teams card updates.

---

## 13. Success criteria

1. An admin approves a budget request from Teams without opening the console, and the user's cap moves by exactly the amount typed on the card.
2. The user can generate against that budget immediately, with no additional step.
3. A decision on either surface is reflected on the other without a manual refresh.
4. A Teams decision's audit row is identical in shape to a console decision's, differing only in actor.
5. Disabling `TEAMS_*` returns the system to exactly today's behaviour.
6. Median time-to-decision on budget requests drops measurably.

---

## 14. Open questions

1. **Shared bot or a dedicated LoglineAI bot?** Blocks Phase 2.
2. **Where does the runtime code live?** The reference doc says hoichoiOS's `apps/console`; the budget logic lives here. Sending directly from this repo is fewer hops but puts a second service on one bot identity.
3. **Which admins receive cards?** All platform admins, or an explicit allowlist? The env var supports either; the product decision is unmade.
4. **Should a Teams denial require a reason?** The console treats it as optional.
