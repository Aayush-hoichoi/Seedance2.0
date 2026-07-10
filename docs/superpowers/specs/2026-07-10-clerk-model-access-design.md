# Clerk Auth + Per-User Model Access & Usage — Design

- **Date:** 2026-07-10
- **Status:** Draft (awaiting review)
- **Scope:** Hosted Next.js website only

## Goal

Replace the single shared-password gate with real per-user authentication (Clerk),
and gate access to the premium **Seedance 2.0 (full)** model behind a request →
admin-approval flow. Every authenticated user gets **Seedance 2.0 Mini** and
**Seedance 2.0 Fast** by default. Admins get a page to approve/revoke access and
see per-user generation usage.

## Decisions (locked)

| Question | Decision |
|---|---|
| Shared gate vs Clerk | **Replace** the shared `APP_AUTH` gate entirely with Clerk. |
| Who can sign up | **Clerk allowlist only** (dashboard setting). Allowlisted email → instant Mini + Fast. |
| Admin identity | **Clerk `publicMetadata.role === 'admin'`** (set in Clerk dashboard). |
| Usage tracking | **Per-generation detail rows** in Neon, **including real USD cost**. |
| Gated models | **Full Seedance 2.0 only.** Mini + Fast are open. Config-driven per model. |
| Cost basis | **Actual** cost = `completion_tokens × official token rate`, finalized when the generation succeeds; an estimate is stored at creation as a fallback. |

## Scope

**In scope (website):**
- Clerk sign-in/up, allowlist-restricted registration, admin role.
- Clerk → Neon webhook keeping a canonical `users` table + child-table emails in sync.
- Per-model gating driven by a `gated` flag in the model catalog.
- Request / approve / revoke flow for gated models.
- Per-generation usage logging **with real USD cost** + admin usage view.
- Enforcement at the ModelArk create-task proxy.

**Out of scope:**
- Electron (Vite) build — separate entry point, untouched.
- Billing, quotas, or hard usage limits — usage is observational only.
- Email/push notifications on request decisions — admin sees them in-app.

## Architecture

**Division of responsibility:**
- **Clerk** owns identity, allowlist-gated sign-up, and the admin role
  (`publicMetadata.role`). No grant/usage state in Clerk metadata (can't be
  aggregated for the admin dashboard).
- **Neon Postgres** owns model-access grants/requests and usage events. Same
  lazy-migration pattern already used by `lib/db/neon.js` `getDb()`.
- **Single enforcement point:** the existing proxy
  `app/api/byteplus/[[...path]]/route.js` — the ModelArk create-task POST
  (`contents/generations/tasks`) already carries the `model` ID in its body.

### Model tiers

Add a `gated` flag to each entry in `lib/seedance/constants.js` `MODELS`:

```js
{ id: PRIMARY_MODEL_ID, name: 'Seedance 2.0',      gated: true,  ... }
{ id: FAST_MODEL_ID,    name: 'Seedance 2.0 Fast', gated: false, ... }
{ id: MINI_MODEL_ID,    name: 'Seedance 2.0 Mini', gated: false, ... }
```

Pure helper `isGatedModel(modelId)` (testable, no I/O). Any future gated model
is a one-flag change.

### Data model (two new Neon tables)

Created in the same `getDb()` lazy-migration chain (`CREATE TABLE IF NOT EXISTS`).

```sql
model_access_requests (
  id            serial PRIMARY KEY,
  user_id       text NOT NULL,           -- Clerk userId
  user_email    text NOT NULL,           -- denormalized for admin display
  model_id      text NOT NULL,           -- the gated model requested
  status        text NOT NULL,           -- 'pending' | 'approved' | 'revoked'
  note          text,                    -- user's justification (optional)
  decided_by    text,                    -- admin email/userId who last decided
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  UNIQUE (user_id, model_id)             -- one grant row per user+model
)

usage_events (
  id                serial PRIMARY KEY,
  user_id           text NOT NULL,
  user_email        text NOT NULL,
  model_id          text NOT NULL,
  resolution        text,
  duration          integer,
  ratio             text,
  mode              text,                -- studio mode (from x-seedance-mode header), nullable
  has_video_input   boolean NOT NULL DEFAULT false,  -- affects the token rate
  task_id           text,                -- ModelArk task id
  status            text NOT NULL DEFAULT 'created',  -- 'created' | 'succeeded' | 'failed'
  completion_tokens bigint,              -- actual tokens billed (from ModelArk usage.completion_tokens)
  est_cost_usd      numeric(10,4),       -- estimate at creation (fallback)
  cost_usd          numeric(10,4),       -- actual, once finalized on success
  created_at        timestamptz NOT NULL DEFAULT now(),
  finalized_at      timestamptz,
  UNIQUE (task_id)                       -- one row per generation; finalize is idempotent
)
```

**Access check:** user has access to a gated model iff a row
`(user_id, model_id)` exists with `status = 'approved'`.

**Request lifecycle (one row per user+model, upsert on `(user_id, model_id)`):**
`request` → `pending` → admin `approve` → `approved` → admin `revoke` →
`revoked`. Re-request from `revoked` sets it back to `pending`. Revoke on a
`pending` row doubles as "reject" (→ `revoked`); no separate denied state.

## Components

### Auth
- **`app/layout.js`** — wrap in `<ClerkProvider>`.
- **`middleware.js`** — replace the `cookieMatches` gate with `clerkMiddleware()`
  + `createRouteMatcher` for public routes (`/sign-in(.*)`, `/sign-up(.*)`).
  **Preserve** the existing muapi `/api/v1` rewrite block verbatim.
- **`app/sign-in/[[...sign-in]]/page.jsx`**, **`app/sign-up/[[...sign-up]]/page.jsx`**
  — Clerk `<SignIn/>` / `<SignUp/>`.
- **Remove:** `lib/auth/credentials.js`, `app/api/auth/login/`, the old
  `app/login/` page, and the `APP_AUTH_*` env usage. Keep `lib/auth/publicPaths.js`
  only if still referenced; otherwise remove.

### Server helpers
- **`lib/auth/user.js`** (server) — `getUser()` → `{ userId, email }` from Clerk
  `auth()` + `currentUser()`; `isAdmin()` → boolean from session claims
  `publicMetadata.role === 'admin'`.
- **`lib/access/db.js`** (server, Neon) —
  `getApprovedModelIds(userId)`, `getRequestFor(userId, modelId)`,
  `requestAccess(userId, email, modelId, note)`,
  `listRequests()`, `approveRequest(id, adminEmail)`, `revokeRequest(id, adminEmail)`,
  `logUsage(event)`, `getUsagePerUser()`, `getUsageForUser(userId)`.
- **`lib/access/decision.js`** (pure, testable) —
  `canUseModel({ modelId, approvedModelIds })` combining `isGatedModel` +
  approved set. Dependency-injected like `lib/seedance/options.mjs`.
- **`lib/seedance/pricing.js`** (pure, testable) — the official token-rate
  table (see Pricing reference) plus:
  `resolutionTier(resolution)` → `'sd'|'1080p'|'4k'`;
  `unitPrice(modelId, resolution, hasVideoInput)` → USD per 1M tokens;
  `costFromTokens(modelId, resolution, hasVideoInput, completionTokens)` → USD (actual);
  `estimateCost({ modelId, resolution, ratio, duration, hasVideoInput })` → USD
  (creation-time fallback via the per-video example figures / formula).

### API routes
| Route | Method | Guard | Purpose |
|---|---|---|---|
| `/api/access/me` | GET | signed-in | `{ allowedModelIds, requests: [{modelId, status}] }` for the studio. |
| `/api/access/request` | POST | signed-in | Body `{ modelId, note }` → upsert request (`pending`). 400 if model not gated. |
| `/api/usage/complete` | POST | signed-in | Body `{ taskId }` → server re-fetches the task from ModelArk. If `succeeded`: read `usage.completion_tokens`, write `cost_usd`, status `succeeded`. If `failed`: status `failed`, `cost_usd = 0` (failures aren't billed). Idempotent; only finalizes rows owned by the caller. |
| `/api/admin/requests` | GET | admin | All requests (pending first) with user email. |
| `/api/admin/requests/[id]/approve` | POST | admin | Set `approved`, stamp `decided_by/at`. |
| `/api/admin/requests/[id]/revoke` | POST | admin | Set `revoked`, stamp `decided_by/at`. |
| `/api/admin/usage` | GET | admin | Per-user aggregates (all-time, v1) + per-model breakdown. Excludes `failed` rows from cost. |

All admin routes call `isAdmin()` server-side and return **403** otherwise.

### Enforcement + logging (in the byteplus proxy POST)
When `path.join('/') === 'contents/generations/tasks'`:
1. `auth()` → `userId`; if none → 401.
2. Parse body → `model`.
3. If `isGatedModel(model)` and `model` not in `getApprovedModelIds(userId)` → **403**
   `{ error: 'You do not have access to this model. Request access from the model picker.' }`.
4. Forward to ModelArk (unchanged).
5. On 2xx with a task `id`: `logUsage({ userId, email, model, resolution, duration,
   ratio, mode, hasVideoInput, taskId, estCostUsd })`. `mode` from the
   `x-seedance-mode` header; `hasVideoInput` derived from the body content roles
   (any `reference_video`/`video_url` item); `estCostUsd` from `estimateCost(...)`.

**Cost finalization:** the studio already polls each task to a terminal state. On
**both** success and failure it fires `POST /api/usage/complete { taskId }`
(success alongside the existing archive call). The server re-fetches the task
(ModelArk GET with the server key): on success it reads `usage.completion_tokens`,
computes `cost_usd = costFromTokens(...)`, status `succeeded`; on failure it sets
status `failed`, `cost_usd = 0`. If the client never pings (tab closed), the row
keeps its `est_cost_usd` — admin usage falls back to the estimate.

All other byteplus paths (upload, assets, archive, polling GET) forward unchanged.

### Frontend
- **Model picker (`app/seedance/PromptBar.jsx` + `SeedanceStudio.jsx`)** — on load,
  fetch `/api/access/me`. A gated model the user lacks renders **locked** (lock
  icon, disabled) with a **Request access** action → `POST /api/access/request`
  → shows "Pending approval." Approved gated models appear normally. Default
  stays Mini.
- **`app/admin/page.jsx`** (server component; `isAdmin()` else `notFound()`):
  - **Requests** table — pending first; Approve / Revoke buttons (client island
    posting to the admin APIs).
  - **Usage** section — per-user totals (generation count + **total USD cost**)
    and per-model breakdown from `/api/admin/usage`. Cost column uses `cost_usd`
    where finalized, else `est_cost_usd`.

## Data flow

**Request access:** user clicks locked model → `POST /api/access/request` →
row upserts to `pending` → admin sees it in `/admin` → Approve → `approved` →
next `/api/access/me` unlocks the model for that user.

**Generate (gated):** studio POSTs create-task → proxy checks approval → allow/deny
→ logs `usage_events` (with `est_cost_usd`) → studio poller reaches a terminal
state → `POST /api/usage/complete` → server finalizes: success writes real
`cost_usd` from `completion_tokens`; failure sets `cost_usd = 0`.

**Revoke:** admin clicks Revoke → row `revoked` → subsequent generations 403.

## Error handling
- Missing Clerk session on a protected API → 401 (middleware normally redirects
  web navigations first).
- Gated model without grant → 403 with an actionable message.
- Neon unreachable: access check **fails closed** for gated models (deny with a
  500-ish "access check unavailable"); usage logging is best-effort
  (fire-and-forget, never blocks a generation).
- `POST /api/usage/complete` for an unknown/foreign `taskId`, or before the task
  succeeds, is a no-op (200) — it never blocks the client; the row keeps its
  estimate and can be finalized on a later ping.
- Admin routes for non-admins → 403.

## Testing
`node --test` (existing pattern), pure logic only; Clerk/Neon I/O is
dependency-injected or mocked:
- `isGatedModel` — flag lookup incl. unknown ids.
- `canUseModel` — open model always allowed; gated allowed only when in approved
  set; unknown id denied.
- Request status transitions — request→pending, approve→approved, revoke→revoked,
  re-request from revoked→pending.
- Pricing (`lib/seedance/pricing.js`) — `resolutionTier` mapping; `unitPrice`
  picks the right rate per (model, tier, hasVideoInput); `costFromTokens` matches
  the official per-video example figures within rounding
  (e.g. full 720p 5s no-video ≈ $0.76, Mini 480p 5s ≈ $0.18).

## Clerk → Neon webhook sync

The app reads Clerk identity live per-request, so no webhook is required for
correctness. A webhook is added purely to keep a **canonical `users` mirror** and
avoid stale/orphaned rows.

```sql
users (
  id text PRIMARY KEY,          -- Clerk userId
  email text, name text, role text,
  created_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz         -- soft-delete so usage history keeps an identity
)
```

- **Endpoint:** `POST /api/webhooks/clerk`, Svix-verified via `verifyWebhook`
  (`@clerk/nextjs/webhooks`, secret `CLERK_WEBHOOK_SIGNING_SECRET`). Public route
  (server-to-server, no session) — allow-listed in `middleware.js`.
- **`user.created` / `user.updated`** → upsert `users`; propagate the current
  email into `model_access_requests` + `usage_events` (keeps admin display fresh).
- **`user.deleted`** → soft-delete the `users` row and delete that user's access
  grants (void); `usage_events` are **retained** for accounting.
- Pure parser `lib/access/clerkUser.mjs` `userFromClerkEvent(data)` (unit-tested);
  DB writes in `lib/access/db.js` (`upsertUser`, `deleteUserData`).
- **Setup:** create the webhook in the Clerk dashboard (events: `user.created`,
  `user.updated`, `user.deleted`), point it at `/api/webhooks/clerk`, and set
  `CLERK_WEBHOOK_SIGNING_SECRET`. Local dev needs a tunnel (e.g. ngrok) since
  Clerk can't reach `localhost`.

## Pricing reference

Official ModelArk **online-inference** token rates (USD per 1M tokens), from the
[Pricing page](https://docs.byteplus.com/en/docs/ModelArk/1544106) as updated
2026-07-08. These live in `lib/seedance/pricing.js` and are the only place to edit
when BytePlus changes rates. Env override optional (e.g. `SEEDANCE_PRICE_OVERRIDES`
JSON) — otherwise hardcoded defaults, mirroring the model-id pattern in `constants.js`.

| Model | Resolution tier | No video input | With video input |
|---|---|---|---|
| `dreamina-seedance-2-0-260128` (full) | 480p/720p | 7.0 | 4.3 |
| | 1080p | 7.7 | 4.7 |
| | 4k | 4.0 | 2.4 |
| `dreamina-seedance-2-0-fast-260128` | 480p/720p | 5.6 | 3.3 |
| `dreamina-seedance-2-0-mini-260615` | 480p/720p | 3.5 | 2.1 |

- **Actual cost** = `unitPrice / 1_000_000 × completion_tokens`
  (`completion_tokens` from ModelArk `usage.completion_tokens`, read server-side).
- **Estimate** (creation-time fallback) uses the official per-video example
  figures / the token formula
  `(input_dur + output_dur) × w × h × fps / 1024`.
- Only **successful** generations are billed (failures cost nothing) — the
  finalize step is what records real cost; failed tasks are marked `failed`,
  `cost_usd = 0`.
- Per-video sanity figures (5s, 16:9, no video input): full 480p ≈ $0.35 /
  720p ≈ $0.76; Fast 480p ≈ $0.28 / 720p ≈ $0.60; Mini 480p ≈ $0.18 / 720p ≈ $0.38.

## Env / Clerk dashboard setup
- Env: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`,
  `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up`.
  Remove `APP_AUTH_USERNAME` / `APP_AUTH_PASSWORD`.
- Clerk dashboard: enable **Restrict sign-ups → Allowlist**, add permitted emails;
  set admin users' `publicMetadata` to `{ "role": "admin" }`.

## Migration
- The shared-gate removal is a hard cutover: after deploy, all access requires a
  Clerk account (allowlisted email). Communicate to existing users.
- `DATABASE_URL` (Neon) is already configured; the two new tables auto-create on
  first request.
