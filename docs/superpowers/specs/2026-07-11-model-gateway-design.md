# Model Gateway — Full Design (single delivery, no phases)

**Goal:** the complete Model Access & Cost Governance PRD — access control, cost attribution, budgets with hard/soft enforcement, job queue, provider routing/failover, real-time SSE governance, audit, dashboards — delivered as one build by evolving this Next.js app.

**Stack (confirmed enough, nothing else needed):** Vercel (Fluid Compute functions, Cron, streaming responses) + Neon Postgres (only database) + Clerk (identity + Organizations). The full existing web app (studio, seedance, gallery, admin) stays.

## 0. Infrastructure substitutions (PRD → this stack)

| PRD says | We use | Why it holds at our scale |
|---|---|---|
| Temporal workflows | `jobs` table in Neon + Vercel Cron sweeper (1/min) + `waitUntil` background processing kicked at enqueue | Generation is already async (ModelArk task polling); retries/timeouts/cancel are row-state transitions |
| Redis pub/sub → SSE | `events` outbox table in Neon; `/api/events` streams SSE from a Vercel function, tailing the outbox (~2s) | Handful of concurrent users; swap to Upstash Redis only if SSE connections reach hundreds |
| KMS for API keys | AES-256-GCM (`node:crypto`) with `KEY_ENCRYPTION_KEY` env secret; ciphertext in Neon | Keys never returned to clients; manual rotation states per PRD |
| Email/Slack alerts | Slack incoming-webhook URL (env) always; Resend email when `RESEND_API_KEY` present | No infra, just keys |
| 12-month hot + S3 cold | Neon only (+ existing TOS bucket for video files) | Data volume is tiny; revisit at millions of rows |

## 1. Schema (Neon — all added to the `getDb()` bootstrap chain)

```sql
-- Identity mirrors ------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
    id text PRIMARY KEY,               -- Clerk org id
    name text, slug text,
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);
-- users table already exists (Clerk webhook mirror)

-- Projects & roles ------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
    id serial PRIMARY KEY,
    org_id text NOT NULL,
    name text NOT NULL,
    paused boolean NOT NULL DEFAULT false,      -- admin queue-pause (PRD §9.1)
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    UNIQUE (org_id, name)
);
CREATE TABLE IF NOT EXISTS project_memberships (
    project_id integer NOT NULL,
    user_id text NOT NULL,
    role text NOT NULL DEFAULT 'member',        -- FK-by-value into roles.id
    added_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS roles (              -- PRD §3: roles are data
    id text PRIMARY KEY,                        -- owner|admin|manager|member|viewer
    description text
);
CREATE TABLE IF NOT EXISTS permissions (
    id text PRIMARY KEY,                        -- e.g. 'model.grant', 'budget.edit'
    description text
);
CREATE TABLE IF NOT EXISTS role_permissions (
    role_id text NOT NULL, permission_id text NOT NULL,
    PRIMARY KEY (role_id, permission_id)
);

-- Model catalog / providers / routing (PRD §6) --------------------------
CREATE TABLE IF NOT EXISTS models (
    id text PRIMARY KEY,                        -- stable alias: 'seedance-2.0'
    display_name text NOT NULL,
    category text NOT NULL,                     -- video | image
    is_default boolean NOT NULL DEFAULT false,  -- org-default set
    active boolean NOT NULL DEFAULT true,
    current_version_id integer                  -- alias → version pointer
);
CREATE TABLE IF NOT EXISTS model_versions (
    id serial PRIMARY KEY,
    model_id text NOT NULL,
    version_tag text NOT NULL,                  -- 'seedance-2-0-260128'
    kind text NOT NULL,                         -- pricing key (RATES)
    caps jsonb,                                 -- {supports1080p, supports4k, ...}
    UNIQUE (model_id, version_tag)
);
CREATE TABLE IF NOT EXISTS providers (
    id text PRIMARY KEY,                        -- 'byteplus' | 'google'
    display_name text
);
CREATE TABLE IF NOT EXISTS provider_routes (
    id serial PRIMARY KEY,
    model_version_id integer NOT NULL,
    provider_id text NOT NULL,
    provider_model_id text NOT NULL,            -- what the provider API expects
    priority integer NOT NULL DEFAULT 1,        -- failover order (PRD §6)
    status text NOT NULL DEFAULT 'active',      -- active | disabled
    UNIQUE (model_version_id, provider_id)
);
CREATE TABLE IF NOT EXISTS api_keys (
    id serial PRIMARY KEY,
    provider_id text NOT NULL,
    scope_org_id text,                          -- org-wide when project null
    scope_project_id integer,
    ciphertext text NOT NULL,                   -- AES-256-GCM(iv||tag||data)
    label text,
    status text NOT NULL DEFAULT 'active',      -- active | retiring | deleted
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Access grants (PRD §5) -------------------------------------------------
CREATE TABLE IF NOT EXISTS project_model_grants (
    id serial PRIMARY KEY,
    project_id integer NOT NULL,
    model_id text NOT NULL,
    valid_from timestamptz, valid_until timestamptz,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    UNIQUE (project_id, model_id)
);
CREATE TABLE IF NOT EXISTS user_model_overrides (
    id serial PRIMARY KEY,
    project_id integer NOT NULL,
    user_id text NOT NULL,
    model_id text NOT NULL,
    effect text NOT NULL,                       -- allow | deny (deny wins)
    valid_from timestamptz, valid_until timestamptz,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    UNIQUE (project_id, user_id, model_id)
);

-- Quotas & budgets (PRD §7) ----------------------------------------------
CREATE TABLE IF NOT EXISTS quotas (
    id serial PRIMARY KEY,
    org_id text NOT NULL,
    project_id integer,                         -- null = org-level
    user_id text,                               -- set = user-in-project level
    type text NOT NULL,          -- usd | credits | image_count | video_seconds | request_count
    "window" text NOT NULL,      -- daily | monthly | lifetime
    hard_limit numeric NOT NULL,
    policy text NOT NULL DEFAULT 'hard',        -- hard | soft
    soft_overage_pct integer NOT NULL DEFAULT 5,
    alert_thresholds integer[] NOT NULL DEFAULT '{80,90,100}',
    created_by text, created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);
CREATE TABLE IF NOT EXISTS quota_alerts_sent (  -- dedupe: one alert per threshold per window
    quota_id integer NOT NULL,
    window_start date NOT NULL,
    threshold integer NOT NULL,
    sent_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (quota_id, window_start, threshold)
);

-- Billing (PRD §8) — append-only, replaces usage_events UPDATE flow ------
CREATE TABLE IF NOT EXISTS billing_events (
    id serial PRIMARY KEY,
    event_type text NOT NULL,    -- reservation | settlement | failure | release
    generation_id integer NOT NULL,             -- jobs.id
    org_id text NOT NULL, project_id integer NOT NULL, user_id text NOT NULL,
    model_id text NOT NULL, model_version_id integer, provider_id text,
    api_key_id integer,
    units jsonb,                 -- {video_seconds, images, completion_tokens}
    est_cost_usd numeric(10,4),  -- on reservation
    cost_usd numeric(10,4),      -- on settlement (from real tokens)
    pricing_snapshot jsonb,      -- unit rates frozen at event time
    created_at timestamptz NOT NULL DEFAULT now()
);
-- No UPDATE/DELETE ever issued; reservation is released by a 'release' or
-- superseded by a 'settlement'/'failure' row for the same generation_id.

-- Job queue (PRD §9) ------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
    id serial PRIMARY KEY,
    org_id text NOT NULL, project_id integer NOT NULL, user_id text NOT NULL,
    model_id text NOT NULL, model_version_id integer,
    priority text NOT NULL DEFAULT 'interactive',  -- interactive | batch
    status text NOT NULL DEFAULT 'queued',
    -- queued|running|succeeded|failed|cancelled|timed_out
    attempt integer NOT NULL DEFAULT 0,            -- of max 3
    request_body jsonb NOT NULL,                   -- ModelArk payload
    provider_task_id text,                         -- ModelArk task id once submitted
    provider_id text,                              -- who actually served it
    error jsonb,
    timeout_at timestamptz,                        -- images +5min, video +30min
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz, finished_at timestamptz
);

-- Events outbox for SSE (PRD §10) -----------------------------------------
CREATE TABLE IF NOT EXISTS events (
    id serial PRIMARY KEY,
    org_id text NOT NULL,
    project_id integer, user_id text,           -- audience filters (null = org-wide)
    type text NOT NULL,
    -- access.granted|access.revoked|access.expired|job.status_changed|
    -- budget.threshold_crossed|project.paused|project.resumed
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Audit (PRD §13) — insert-only -------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id serial PRIMARY KEY,
    actor_id text NOT NULL, actor_email text,
    action text NOT NULL, target_type text, target_id text,
    before jsonb, after jsonb,
    reason text, ip text,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Rollups (PRD §8.2/§14) ---------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_rollups_daily (
    day date NOT NULL,
    org_id text NOT NULL, project_id integer NOT NULL, user_id text NOT NULL,
    model_id text NOT NULL, provider_id text,
    generations integer NOT NULL DEFAULT 0,
    failures integer NOT NULL DEFAULT 0,
    video_seconds numeric NOT NULL DEFAULT 0,
    images integer NOT NULL DEFAULT 0,
    cost_usd numeric(12,4) NOT NULL DEFAULT 0,
    PRIMARY KEY (day, org_id, project_id, user_id, model_id)
);
```

Indexes on every §8.2 dimension: `billing_events(org_id, created_at)`, `(project_id, user_id)`, `(model_id)`, `jobs(status, priority, created_at)`, `events(id)` tailing, `user_model_overrides(user_id, project_id)`.

## 2. Authorization

**Roles** seeded per PRD §3 (owner, admin, manager, member, viewer) with `role_permissions` rows; one pure helper `hasPermission(roleId, permissionId, rolePermissionRows)`. Clerk org role `org:admin` maps to gateway `admin`; ≥1 owner enforced in the users API.

**Model access precedence** — pure `effectiveAccess()` (evolves `lib/access/decision.mjs`, full `node --test` coverage):

```
1. active user DENY  (project, user, model)   → deny      (strongest)
2. active user ALLOW                          → allow     (early access / migrated approvals)
3. active project grant                       → allow
4. model.is_default                           → allow
5. otherwise                                  → deny      (deny by default)
```

"Active" = `revoked_at IS NULL` AND now within `[valid_from, valid_until]` (nulls unbounded). Expiry is therefore enforced on every request; a cron (below) also *pushes* `access.expired` at the boundary.

## 3. Quotas, budgets & reservations (PRD §7)

- All five limit types; all three windows; layerable org / project / user-in-project. A request must pass **every** applicable quota.
- **Enqueue-time check:** `settled_usage(window) + open_reservations + estimated_cost ≤ limit × (policy=soft ? 1+overage% : 1)`. Estimated cost from `pricing.mjs` `EXAMPLE`/`unitPrice` figures.
- Reservation = `billing_events` row (`event_type='reservation'`, est_cost). Settlement/failure row closes it; cancellation writes `release`. Open reservation = reservation without a closing row (queryable with a `NOT EXISTS`).
- On breach: `429 { code:'QUOTA_EXCEEDED', limit:{scope,type,window}, resets_at }`.
- **Alerts:** after every settlement, a shared `checkThresholds()` compares window usage to each quota's thresholds; `quota_alerts_sent` dedupes; fires Slack webhook (always) + Resend email (if key) + `budget.threshold_crossed` event → SSE + in-app feed.

## 4. Job lifecycle & queue (PRD §9)

```
POST /api/generations
  AuthN → membership → effectiveAccess → quota check → reservation
  → INSERT jobs(queued) → 202 {generation_id} → waitUntil(processQueue())
```

**processQueue()** (also run by Vercel Cron every minute as sweeper — catches crashes, timeouts, expiries):
1. Claim: `UPDATE jobs SET status='running', started_at=now(), attempt=attempt+1 WHERE id = (SELECT id FROM jobs WHERE status='queued' AND project not paused ORDER BY priority='interactive' DESC, created_at ASC ... FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *` — atomic, safe across concurrent instances. Per-org fairness: round-robin pick across orgs at same priority.
2. Concurrency gates (checked before claim): running count per (provider, model) < provider cap; running per project < tenant cap (default 5). Caps live in a `settings` jsonb or env.
3. Submit to provider via routing (§5); store `provider_task_id`; poll ModelArk until done/`timeout_at`.
4. Terminal: write settlement/failure billing event, `job.status_changed` event, run `checkThresholds()`.
5. Retries: 3 attempts, exponential backoff (re-queue with `created_at=now()+delay`); provider failover consumes the same attempt budget; non-retryable errors (content policy, bad input) fail immediately.
6. Timeouts: images 5 min, video 30 min (`timeout_at`); sweeper marks `timed_out`, records any provider-billed cost.
7. Cancel: queued → cancelled free (release reservation, cancel event); running → provider cancel attempted, else completes with cost recorded and result discarded.
8. Pause: `projects.paused` — queued jobs hold, new submissions get `409 PROJECT_PAUSED`.
9. Depth cap: 100 queued per project → `429 QUEUE_FULL`.

The existing direct `/api/byteplus` create-task path is **replaced** by `/api/generations`; the studio switches to it. Status polling moves to `GET /api/generations/:id` (backed by jobs + ModelArk poll).

## 5. Providers, routing, failover, keys (PRD §6)

- `submitGeneration(job)` resolves alias → `current_version_id` → `provider_routes` ordered by priority, skipping `disabled`; tries each on 5xx/timeout/unavailable; cost attributed to the provider that served it.
- Provider adapters (one module each, same interface `create/poll/cancel`): **byteplus** (Seedance video + Seedream image — same ModelArk API) complete; **google** (Nano Banana Pro/2) via the **Gemini Batch API** — decided: batch mode is 50% of interactive pricing and its async shape (submit batch → poll job → retrieve) maps 1:1 onto the adapter interface and our queue; routes `disabled` until a Google key is configured. Batch-mode unit rates go into `pricing.mjs` and every event's `pricing_snapshot`.
- Keys: `api_keys` ciphertext via AES-256-GCM (`lib/crypto/keybox.mjs`, pure, tested); resolution order project-scoped → org-scoped → env fallback (`ARK_API_KEY` etc.); rotation = new active key, old → `retiring`, delete after drain. Never serialized to clients — admin UI shows label + last4 only.
- Alias repoint (`models.current_version_id`) is an admin action + audit row — config change, no migration.

## 6. Real-time events — SSE (PRD §10)

- `GET /api/events` (Fluid function, `maxDuration` 300s): authenticates, then tails `events` where audience matches (org + user's projects + user), polling Neon every 2 s, emitting SSE with `id:` = event id; supports `Last-Event-ID` resume. Client `EventSource` auto-reconnects each ~5 min window.
- Every governance mutation (grant/revoke/override/pause/budget-cross/job transition) inserts an outbox row in the same transaction as its DB write — enforcement never depends on delivery.
- **Expiry cron** (1/min): finds grants/overrides where `valid_until` just passed and unexpired-notified, emits `access.expired`, cancels affected queued jobs (same consumer as revoke).
- Revoke flow per PRD §10.2: new requests rejected at authz; queued jobs cancelled; running jobs complete and settle.

## 7. API surface (PRD §11.2 → Next.js routes)

```
POST   /api/generations                      submit (202 + generation_id)
GET    /api/generations/:id                  status/result
DELETE /api/generations/:id                  cancel
GET    /api/models?projectId=                effective catalog for caller
GET    /api/projects                         mine  ·  POST create (admin)
PATCH  /api/projects/:id                     rename / pause / resume (admin)
POST/DELETE /api/projects/:id/members        add/remove, set role
POST/DELETE /api/projects/:id/models         grant/revoke (+valid_until)
POST/DELETE /api/projects/:id/overrides      user allow/deny (+expiry)
GET    /api/projects/:id/usage?group_by=user|model|day&window=
GET    /api/orgs/usage                       org rollups (admin)
GET    /api/admin/audit?actor=&action=&target=&from=&to=   (+ CSV export)
GET    /api/admin/keys · POST · PATCH(rotate/retire)
GET    /api/admin/quotas · POST · PATCH · DELETE
GET    /api/events                           SSE stream
GET    /api/export/usage.csv?scope=          billing-event export
```

Error contract everywhere: `{ code, message, rule|limit, resets_at? }` with codes `MODEL_ACCESS_DENIED · QUOTA_EXCEEDED · QUEUE_FULL · PROJECT_PAUSED · NOT_A_PROJECT_MEMBER · FORBIDDEN`.

Existing `/api/access/request` self-serve flow stays; admin approval writes a user ALLOW override (this is why ALLOW overrides exist despite PRD Q1's restrict-only lean — the live approve flow and its data migrate 1:1).

## 8. UI/UX — the console (best-in-class, package-built)

**Design system:** shadcn/ui (Radix primitives, JSX mode, Tailwind 3 — matches repo), **Recharts** via shadcn charts for all visualization, **TanStack Table v8** for every data grid (sort/filter/paginate), **SWR** for data fetching with SSE-driven revalidation, `react-hot-toast` (already present) for feedback. Dark theme matching the existing studio aesthetic; CSS variables for theming.

**New app shell** at `/console` — persistent left nav (collapsible, keyboard navigable), org header, user button, real-time connection indicator:

| Page | Contents |
|---|---|
| **Dashboard** | Org spend today/this month (stat cards with deltas), spend-by-project stacked area, spend-by-model donut, top users bar, live budget consumption bars, alert feed |
| **Projects** | Grid of project cards (spend, members, models, paused badge) → detail page with tabs: Members (role select, add/remove), Models (grant toggles + expiry date picker), Overrides (per-user allow/deny + expiry), Budget (quota editor with visual threshold slider), Usage (per-user/per-model charts) |
| **Models** | Catalog table: alias, category, current version, providers with priority + health, default flag; alias-repoint dialog; per-model spend sparkline |
| **Queue** | Live jobs table (SSE-updated): status chips, priority, attempt, wait time; cancel buttons; per-project pause/resume; depth + concurrency gauges |
| **Usage** | Explorer: group-by picker (project/user/model/provider/day), window picker, chart + table views, CSV export |
| **Budgets** | All quotas across scopes; consumption bars; policy (hard/soft) editor; alert threshold chips |
| **Audit** | Filterable timeline (actor, action, target, date range), before/after diff viewer, export |
| **Users** | Existing admin user management folded in (role change, remove) |

The current `/admin` page's features (access requests, users, usage) migrate into the console; `/admin` redirects to `/console`.

**Studio (user-facing) changes:** project picker in top bar (hidden with one project, persisted per user); model picker driven by `/api/models` (allowed / locked-with-request-button / denied states with tooltips explaining which rule applied); live toast + banner on `access.revoked`/`access.expired`/`budget.threshold_crossed` via the shared `useEvents()` SSE hook; generation cards show queue state from `job.status_changed` instead of raw ModelArk polling; per-generation cost shown on completion; graceful `QUOTA_EXCEEDED` sheet showing which limit bound and when it resets.

**Performance budget:** charts and heavy tables lazy-loaded (`next/dynamic`); server components for first paint of dashboard data; SWR cache + SSE invalidation instead of poll loops; one shared EventSource per tab; virtualized rows past 200 entries; route-level code splitting keeps studio bundle unaffected by console.

## 9. Analytics & rollups

- Nightly cron aggregates yesterday's `billing_events` + `jobs` into `usage_rollups_daily`; today is always computed on-demand (small) and unioned in.
- Operational metrics from existing rows (no extra collection): provider error rate & failover count from `jobs.error/provider_id`, queue wait p50/p95 from `started_at-created_at`, generation latency from `finished_at-started_at`, reservation-vs-settled drift from billing event pairs.
- Monthly reconcile view: settled totals per provider per month, for manual comparison against provider invoices.

## 10. Migration & seeds (one-time, idempotent script)

1. Enable Clerk **Organizations** (manual, both instances); create the hoichoi org; webhook additions `organization.*` mirror into `organizations`.
2. Seed `roles`/`permissions`/`role_permissions`; seed `providers` (byteplus, google); seed `models`/`model_versions`/`provider_routes` from `constants.js` `MODELS` + PRD catalog (Seedream 5.0-pro default image, Nano Banana routes disabled until key). `GATED_MODEL_IDS` and the `gated` flag are deleted from code — gating is now purely rows.
3. Create project **"Default"**, enroll all existing `users`.
4. `model_access_requests.approved` → ALLOW overrides on Default; `pending` untouched; `revoked` → nothing.
5. `usage_events` history → backfilled `billing_events` settlements (org/project = defaults); `usage_events` table then frozen (kept read-only for safety, dropped later).

## 11. Testing

- **Pure (node --test, dependency-injected):** `effectiveAccess` precedence + expiry edges; quota layering + reservation math + soft-overage; queue pick order (priority, org fairness, concurrency gates); retry/backoff/timeout state transitions; keybox encrypt/decrypt roundtrip; rollup aggregation; pricing snapshot.
- **Route-level:** authz matrix per endpoint (each role × each route), error-code contract.
- **E2E (Playwright, critical flows):** grant → generate → revoke mid-queue → SSE banner → 403 on retry; budget crossing → alert + hard stop.

## 12. Build order (dependency order — everything ships)

1. Schema + seeds + migration script; Clerk Organizations + webhooks
2. `effectiveAccess` + roles/permissions helpers (pure, tested)
3. Billing events + reservations + quota engine (pure core, tested)
4. Jobs queue + processor + crons (sweeper, expiry, rollup) + provider adapters/routing/keybox
5. `/api/generations` + all governance API routes + audit helper + error contract
6. Events outbox + SSE endpoint + `useEvents()` hook
7. Console shell + all eight pages (shadcn/ui, Recharts, TanStack Table, SWR)
8. Studio integration (project picker, model states, live banners, queue-backed cards)
9. Rollups, exports, dashboards polish; Playwright flows; migration run

**New dependencies:** shadcn/ui-generated components (Radix packages), `recharts`, `@tanstack/react-table`, `swr`, `resend` (optional, env-gated). Everything else is stdlib/platform.
