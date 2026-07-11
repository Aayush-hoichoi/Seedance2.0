# Model Gateway — Phase 1 Design (this repo)

**Goal:** PRD Phase 1 ("Foundation") of the Model Access & Cost Governance Platform, built by evolving this Next.js + Clerk + Neon + Vercel app. No new infrastructure.

**Decisions locked (from PRD open questions + owner answers):**

| Question | Decision |
|---|---|
| Build target | Evolve this repo; the full existing app (studio, seedance, gallery) stays. Everything on Next.js. |
| Clerk mapping (Q6) | One Clerk org = Organization. Projects are **our own table** keyed to the org; Clerk does identity + org membership only. |
| User-level ALLOW (Q1) | **Both ALLOW and DENY overrides.** PRD recommended restrict-only, but the live product already has per-user approvals (`model_access_requests`) that migrate 1:1 into ALLOW overrides — restrict-only would break the existing request→approve flow. DENY always wins. |
| Credits vs USD (Q2) | USD. `pricing.mjs` already snapshots real token cost per event. |
| Roles | No `Role`/`Permission` tables in v1. Clerk org role (admin/member) + a `role` column on `project_memberships` (`manager` \| `member` \| `viewer`). Mapping tables come when a role needs custom permissions. |
| Time-based grants (Q7) | `valid_from`/`valid_until` on every grant/override in schema; UI exposes expiry (`valid_until`) only. |
| Orchestration (Q3), SSE, quotas | **Phase 2.** Interim revoke UX: the studio already refetches `/api/access/me`; enforcement is server-side on every create-task regardless. |
| Provider failover | **Phase 3.** Single provider (BytePlus) today; schema reserves `provider` columns. |

---

## 1. Schema (Neon, added to the `getDb()` bootstrap chain)

```sql
CREATE TABLE IF NOT EXISTS organizations (
    id text PRIMARY KEY,              -- Clerk org id
    name text,
    slug text,
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS projects (
    id serial PRIMARY KEY,
    org_id text NOT NULL,
    name text NOT NULL,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS project_memberships (
    project_id integer NOT NULL,
    user_id text NOT NULL,
    role text NOT NULL DEFAULT 'member',   -- manager | member | viewer
    added_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS models (
    id text PRIMARY KEY,              -- stable alias, e.g. 'seedance-2.0'
    display_name text NOT NULL,
    category text NOT NULL,           -- video | image
    provider text NOT NULL DEFAULT 'byteplus',
    provider_model_id text NOT NULL,  -- rotating dated id (env-overridable today)
    kind text NOT NULL,               -- pricing key into pricing.mjs RATES
    is_default boolean NOT NULL DEFAULT false,  -- org-default set (PRD §5.1 rule 4)
    active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS project_model_grants (
    id serial PRIMARY KEY,
    project_id integer NOT NULL,
    model_id text NOT NULL,
    valid_from timestamptz,
    valid_until timestamptz,
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
    effect text NOT NULL,             -- allow | deny
    valid_from timestamptz,
    valid_until timestamptz,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    UNIQUE (project_id, user_id, model_id)
);

CREATE TABLE IF NOT EXISTS audit_log (          -- insert-only
    id serial PRIMARY KEY,
    actor_id text NOT NULL,
    actor_email text,
    action text NOT NULL,             -- e.g. 'model.grant', 'member.remove'
    target_type text,
    target_id text,
    before jsonb,
    after jsonb,
    reason text,
    ip text,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS org_id text;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS project_id integer;
```

**Deliberate deviation from PRD §8.1:** `usage_events` keeps its finalize `UPDATE` (created → succeeded/failed with real token cost) instead of splitting into reservation/settle event pairs. Costs are still never recalculated. Append-only pairs arrive in Phase 2 with budget reservations, which is the feature that actually needs them.

## 2. Access decision (pure, extends `lib/access/decision.mjs` pattern)

```
effectiveAccess({ modelId, now, projectGrants, userOverrides, defaultModelIds })
  1. active DENY override for (user, project, model)  → deny   (strongest)
  2. active ALLOW override                            → allow
  3. active project grant for model                   → allow
  4. model in org-default set (models.is_default)     → allow
  5. otherwise                                        → deny   (deny by default)
```

"Active" = `revoked_at IS NULL` and `now` within `[valid_from, valid_until]` (null = unbounded). Pure function, dependency-injected rows, `node --test` coverage for every precedence rule and expiry edge (replaces/extends `tests/accessDecision.test.mjs`).

## 3. Clerk integration

- Enable **Organizations** in the Clerk dashboard (manual step, both instances).
- Webhook handler adds: `organization.created/updated/deleted` → mirror into `organizations`. Org *membership* stays in Clerk (used to gate admin UI); project membership is ours.
- v1 reality: one org (hoichoi), all users members. The schema is multi-org from day one; the UI can ignore org switching until it matters.

## 4. Request flow (the gateway check)

`POST /api/byteplus/.../create-task` body gains `project_id`:

```
AuthN (Clerk) → membership check (user ∈ project) → effectiveAccess (§2)
  → 403 { code: MODEL_ACCESS_DENIED | NOT_A_PROJECT_MEMBER, message, rule }
  → forward to ModelArk → usage_events row now carries org_id + project_id
```

`GET /api/models?projectId=` returns the caller's effective model list (allowed / denied / can-request) — drives the studio model picker.

## 5. API surface (new/changed routes)

| Route | Who | Does |
|---|---|---|
| `GET/POST /api/projects` | member / org-admin | list my projects / create |
| `POST/DELETE /api/projects/:id/members` | org-admin, manager | add/remove member, set role |
| `POST/DELETE /api/projects/:id/models` | org-admin | grant/revoke model (+ `valid_until`) |
| `POST/DELETE /api/projects/:id/overrides` | org-admin | user ALLOW/DENY (+ expiry) |
| `GET /api/projects/:id/usage?group_by=user\|model\|day` | manager+ | project rollups |
| `GET /api/models?projectId=` | member | effective catalog for picker |
| `GET /api/admin/audit` | org-admin | audit trail |
| existing `/api/access/request` + admin approve | unchanged UX | approval now writes a user ALLOW override in the chosen project |

Every mutating admin route calls one `writeAudit()` helper (actor, action, target, before/after, ip).

## 6. Migration (one-time, idempotent)

1. Seed `organizations` from the Clerk org; create project **"Default"**; enroll every existing `users` row as member.
2. Seed `models` from `constants.js` `MODELS` (3 Seedance video models; image models get rows when integrated). `constants.js` keeps UI mode/option data; **gating moves to the DB** (`GATED_MODEL_IDS` deleted).
3. `model_access_requests` `approved` rows → ALLOW overrides on Default; `pending` untouched (request flow lives on); `revoked` → nothing (absence = deny).
4. Backfill `usage_events.org_id/project_id` with the defaults.

## 7. UI

**/admin** — new **Projects** tab (create project; members with roles; model grants with expiry date; per-user overrides), **Audit** tab, Usage tab gains project dimension + group-by. Access-requests tab unchanged.

**Studio** — project picker in the top bar (hidden when the user has one project); selection persisted in localStorage and sent as `project_id`; model picker states from `/api/models`.

## 8. Explicitly out of Phase 1

Quotas/budgets/reservations · alerts · SSE push · job queue/concurrency/priority · provider routing & failover · per-project API keys · exports · webhooks. (Phase 2/3 per PRD §16.)

## 9. Build order

1. Schema + seeds + migration of existing rows
2. Clerk Organizations + webhook mirror
3. `effectiveAccess` decision function + tests
4. Proxy enforcement with `project_id`; usage columns
5. Projects/models/overrides API routes + `writeAudit`
6. `/api/models` effective-catalog route
7. Admin Projects + Audit tabs; usage group-by
8. Studio project picker + picker states
