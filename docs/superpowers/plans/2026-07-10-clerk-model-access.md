# Clerk Auth + Per-User Model Access & Cost Tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared-password gate with Clerk per-user auth, gate the full Seedance 2.0 model behind a request→approve flow, and log per-generation usage with real USD cost, surfaced on an admin page.

**Architecture:** Clerk owns identity (allowlist sign-up) + admin role (`publicMetadata.role`). Neon owns access grants/requests and usage events. The single ModelArk create-task proxy (`app/api/byteplus/[[...path]]/route.js`) enforces model access and logs usage; the studio finalizes real cost on task completion.

**Tech Stack:** Next.js 15 (App Router), `@clerk/nextjs` v6, `@neondatabase/serverless`, `node --test`.

## Global Constraints

- **No `"type": "module"` in package.json.** Pure, unit-tested modules are `.mjs` (like `lib/seedance/options.mjs`); `node --test` cannot import ESM `.js`.
- **Test command:** `node --test tests/*.test.js tests/*.test.mjs`.
- **No `console.log` in production code** (hooks flag it). `console.error` for server error logging is fine (matches `lib/db/neon.js`).
- **Immutability:** return new objects; never mutate inputs.
- **Do not push.** Commit locally on branch `feat/clerk-model-access` only.
- **Model ids** are env-overridable in `lib/seedance/constants.js`; pricing keys off a stable `kind` (`full`/`fast`/`mini`), never the raw id.
- **Preserve** the muapi `/api/v1` rewrite logic in `middleware.js` verbatim.

---

## Phase 1 — Pure logic (TDD)

### Task 1: Model tiers in the catalog

**Files:**
- Modify: `lib/seedance/constants.js`

**Interfaces:**
- Produces: `MODELS[i].gated: boolean`, `MODELS[i].kind: 'full'|'fast'|'mini'`, `export const GATED_MODEL_IDS: string[]`.

- [ ] **Step 1: Add `kind` + `gated` to each model and export the gated id list**

In `lib/seedance/constants.js`, change the `MODELS` array and add an export directly after it:

```js
export const MODELS = [
    // Resolution gating per BytePlus ModelArk: only the full Seedance 2.0 model
    // outputs 4k (10-bit HDR); Fast and Mini top out at 720p (no 1080p, no 4k).
    // `gated`: requires an approved access request (full 2.0 only). `kind`: stable
    // pricing/tier key, immune to model-id rotation via env.
    { id: PRIMARY_MODEL_ID, name: 'Seedance 2.0', kind: 'full', gated: true, supports1080p: true, supports4k: true },
    { id: FAST_MODEL_ID, name: 'Seedance 2.0 Fast', kind: 'fast', gated: false, supports1080p: false, supports4k: false },
    { id: MINI_MODEL_ID, name: 'Seedance 2.0 Mini', kind: 'mini', gated: false, supports1080p: false, supports4k: false },
];

// Ids that require an approved access request. Derived so a future gated model
// is a one-flag change.
export const GATED_MODEL_IDS = MODELS.filter((m) => m.gated).map((m) => m.id);
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `node --test tests/*.test.js tests/*.test.mjs`
Expected: PASS (57 tests) — additive change, nothing else references the new fields yet.

- [ ] **Step 3: Commit**

```bash
git add lib/seedance/constants.js
git commit -m "feat: add kind + gated flags and GATED_MODEL_IDS to the model catalog"
```

---

### Task 2: Access decision (pure)

**Files:**
- Create: `lib/access/decision.mjs`
- Test: `tests/accessDecision.test.mjs`

**Interfaces:**
- Produces: `canUseModel({ modelId, gatedModelIds, approvedModelIds }) -> boolean`.

- [ ] **Step 1: Write the failing test**

Create `tests/accessDecision.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseModel } from '../lib/access/decision.mjs';

const GATED = ['full-2-0'];

test('open model is always allowed', () => {
    assert.equal(canUseModel({ modelId: 'mini', gatedModelIds: GATED, approvedModelIds: [] }), true);
});

test('gated model denied without a grant', () => {
    assert.equal(canUseModel({ modelId: 'full-2-0', gatedModelIds: GATED, approvedModelIds: [] }), false);
});

test('gated model allowed with a grant', () => {
    assert.equal(canUseModel({ modelId: 'full-2-0', gatedModelIds: GATED, approvedModelIds: ['full-2-0'] }), true);
});

test('missing / unknown modelId denied', () => {
    assert.equal(canUseModel({ modelId: '', gatedModelIds: GATED, approvedModelIds: [] }), false);
    assert.equal(canUseModel({ modelId: undefined, gatedModelIds: GATED, approvedModelIds: [] }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/accessDecision.test.mjs`
Expected: FAIL — cannot find `../lib/access/decision.mjs`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/access/decision.mjs`:

```js
// Pure model-access decision. Dependency-injected (gated + approved sets passed
// in, not imported) so it runs under `node --test` without loading ESM constants.

export function canUseModel({ modelId, gatedModelIds, approvedModelIds }) {
    if (!modelId) return false;
    if (!gatedModelIds.includes(modelId)) return true; // open model — no grant needed
    return approvedModelIds.includes(modelId);         // gated — needs an approved grant
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/accessDecision.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/access/decision.mjs tests/accessDecision.test.mjs
git commit -m "feat: pure canUseModel access-decision helper"
```

---

### Task 3: Pricing (pure)

**Files:**
- Create: `lib/seedance/pricing.mjs`
- Test: `tests/pricing.test.mjs`

**Interfaces:**
- Produces: `resolutionTier(resolution) -> 'sd'|'1080p'|'4k'`; `unitPrice(kind, resolution, hasVideoInput) -> number|null` (USD per 1M tokens); `costFromTokens(kind, resolution, hasVideoInput, completionTokens) -> number|null`; `estimateCost({ kind, resolution, duration, hasVideoInput }) -> number|null`.

- [ ] **Step 1: Write the failing test**

Create `tests/pricing.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolutionTier, unitPrice, costFromTokens, estimateCost } from '../lib/seedance/pricing.mjs';

test('resolutionTier maps 480p/720p to sd, 1080p and 4k to themselves', () => {
    assert.equal(resolutionTier('480p'), 'sd');
    assert.equal(resolutionTier('720p'), 'sd');
    assert.equal(resolutionTier('1080p'), '1080p');
    assert.equal(resolutionTier('4k'), '4k');
});

test('unitPrice picks the right rate per model/tier/video-input', () => {
    assert.equal(unitPrice('full', '720p', false), 7.0);
    assert.equal(unitPrice('full', '720p', true), 4.3);
    assert.equal(unitPrice('full', '4k', true), 2.4);
    assert.equal(unitPrice('fast', '720p', false), 5.6);
    assert.equal(unitPrice('mini', '480p', true), 2.1);
});

test('unitPrice returns null for unsupported combos', () => {
    assert.equal(unitPrice('fast', '4k', false), null); // Fast has no 4k tier
    assert.equal(unitPrice('nope', '720p', false), null);
});

test('costFromTokens = unitPrice/1e6 * tokens, rounded to 4dp', () => {
    assert.equal(costFromTokens('mini', '480p', false, 1_000_000), 3.5);
    assert.equal(costFromTokens('full', '720p', false, 500_000), 3.5);
    assert.equal(costFromTokens('full', '4k', false, 0), 0);
    assert.equal(costFromTokens('nope', '720p', false, 100), null);
});

test('estimateCost scales the 5s example by duration', () => {
    assert.equal(estimateCost({ kind: 'mini', resolution: '480p', duration: 5, hasVideoInput: false }), 0.18);
    assert.equal(estimateCost({ kind: 'mini', resolution: '480p', duration: 10, hasVideoInput: false }), 0.36);
    assert.equal(estimateCost({ kind: 'full', resolution: '720p', duration: 5, hasVideoInput: false }), 0.76);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/pricing.test.mjs`
Expected: FAIL — cannot find `../lib/seedance/pricing.mjs`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/seedance/pricing.mjs`:

```js
// Official BytePlus ModelArk online-inference token rates (USD per 1M tokens),
// keyed by stable `kind` (immune to model-id rotation). Source: ModelArk Pricing
// page, updated 2026-07-08. Update RATES here when BytePlus changes prices.
// Pure + no imports so it runs under `node --test`.

const RATES = {
    // kind: { tier: [noVideoInput, withVideoInput] }
    full: { sd: [7.0, 4.3], '1080p': [7.7, 4.7], '4k': [4.0, 2.4] },
    fast: { sd: [5.6, 3.3] },
    mini: { sd: [3.5, 2.1] },
};

// Per-video example figures (5s, 16:9, no video input) — used only for the
// creation-time cost estimate; the real cost comes from costFromTokens on finalize.
const EXAMPLE_5S = {
    full: { '480p': 0.35, '720p': 0.76, '1080p': 1.87, '4k': 3.89 },
    fast: { '480p': 0.28, '720p': 0.60 },
    mini: { '480p': 0.18, '720p': 0.38 },
};

export function resolutionTier(resolution) {
    if (resolution === '4k') return '4k';
    if (resolution === '1080p') return '1080p';
    return 'sd'; // 480p / 720p
}

export function unitPrice(kind, resolution, hasVideoInput) {
    const tiers = RATES[kind];
    if (!tiers) return null;
    const rate = tiers[resolutionTier(resolution)];
    if (!rate) return null;
    return rate[hasVideoInput ? 1 : 0];
}

export function costFromTokens(kind, resolution, hasVideoInput, completionTokens) {
    const up = unitPrice(kind, resolution, hasVideoInput);
    if (up == null || completionTokens == null) return null;
    return Number((up / 1_000_000 * completionTokens).toFixed(4));
}

export function estimateCost({ kind, resolution, duration, hasVideoInput }) {
    const table = EXAMPLE_5S[kind];
    if (!table) return null;
    const base = table[resolution] ?? table['720p'] ?? null;
    if (base == null) return null;
    const dur = typeof duration === 'number' && duration > 0 ? duration : 5;
    let cost = base * (dur / 5);
    if (hasVideoInput) cost *= 1.1; // ponytail: rough +10% for video input; finalize corrects it
    return Number(cost.toFixed(4));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/pricing.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/seedance/pricing.mjs tests/pricing.test.mjs
git commit -m "feat: Seedance token-rate pricing module (unit price, actual cost, estimate)"
```

---

### Task 4: Request status transitions (pure)

**Files:**
- Create: `lib/access/requestStatus.mjs`
- Test: `tests/requestStatus.test.mjs`

**Interfaces:**
- Produces: `nextStatus(action) -> 'pending'|'approved'|'revoked'` (throws on unknown action).

- [ ] **Step 1: Write the failing test**

Create `tests/requestStatus.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStatus } from '../lib/access/requestStatus.mjs';

test('maps each action to its status', () => {
    assert.equal(nextStatus('request'), 'pending');
    assert.equal(nextStatus('approve'), 'approved');
    assert.equal(nextStatus('revoke'), 'revoked');
});

test('throws on an unknown action', () => {
    assert.throws(() => nextStatus('delete'), /Unknown action/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/requestStatus.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

Create `lib/access/requestStatus.mjs`:

```js
// The model-access request state machine, as a pure map. Revoke doubles as
// "reject a pending request" — there is no separate denied state.
const BY_ACTION = { request: 'pending', approve: 'approved', revoke: 'revoked' };

export function nextStatus(action) {
    const status = BY_ACTION[action];
    if (!status) throw new Error(`Unknown action: ${action}`);
    return status;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/requestStatus.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/access/requestStatus.mjs tests/requestStatus.test.mjs
git commit -m "feat: pure request-status transition helper"
```

---

## Phase 2 — Data layer (Neon)

### Task 5: Create the two Neon tables (lazy migration)

**Files:**
- Modify: `lib/db/neon.js:17-38`

**Interfaces:**
- Consumes: `getDb()` (existing).
- Produces: tables `model_access_requests`, `usage_events` guaranteed to exist after `getDb()` resolves.

- [ ] **Step 1: Extend the migration chain**

In `lib/db/neon.js`, inside `getDb()`, append two `CREATE TABLE` statements to the existing `tableReady` promise chain — insert them immediately before the final `.catch(...)`:

```js
            .then(() => sql`CREATE TABLE IF NOT EXISTS model_access_requests (
                id serial PRIMARY KEY,
                user_id text NOT NULL,
                user_email text NOT NULL,
                model_id text NOT NULL,
                status text NOT NULL,
                note text,
                decided_by text,
                created_at timestamptz NOT NULL DEFAULT now(),
                decided_at timestamptz,
                UNIQUE (user_id, model_id)
            )`)
            .then(() => sql`CREATE TABLE IF NOT EXISTS usage_events (
                id serial PRIMARY KEY,
                user_id text NOT NULL,
                user_email text NOT NULL,
                model_id text NOT NULL,
                resolution text,
                duration integer,
                ratio text,
                mode text,
                has_video_input boolean NOT NULL DEFAULT false,
                task_id text,
                status text NOT NULL DEFAULT 'created',
                completion_tokens bigint,
                est_cost_usd numeric(10,4),
                cost_usd numeric(10,4),
                created_at timestamptz NOT NULL DEFAULT now(),
                finalized_at timestamptz,
                UNIQUE (task_id)
            )`)
```

- [ ] **Step 2: Verify the migration runs (manual, requires DATABASE_URL)**

Run: `npm run dev`, then in a browser hit any authed page (or once Task 11 lands, `curl localhost:3001/api/access/me`). Then confirm the tables exist:

```bash
psql "$DATABASE_URL" -c "\dt model_access_requests" -c "\dt usage_events"
```
Expected: both tables listed. (If `psql` unavailable, skip — the app will error clearly if creation failed.)

- [ ] **Step 3: Commit**

```bash
git add lib/db/neon.js
git commit -m "feat: create model_access_requests + usage_events tables"
```

---

### Task 6: Access + usage DB queries

**Files:**
- Create: `lib/access/db.js`

**Interfaces:**
- Consumes: `getDb()`; `MODELS` from constants; `costFromTokens` from pricing.
- Produces: `getApprovedModelIds(userId)`, `getRequestsForUser(userId)`, `requestAccess(userId, email, modelId, note)`, `listRequests()`, `setRequestStatus(id, status, decidedBy)`, `logUsage(event)`, `finalizeUsage(taskId, userId, { status, completionTokens })`, `getUsagePerUser()`, `getUsagePerUserModel()`.

- [ ] **Step 1: Write the module**

Create `lib/access/db.js`:

```js
// Server-only. Model-access grants/requests + usage-event persistence on Neon.
// Thin wrappers over getDb(); never import into client code.

import { getDb } from '../db/neon.js';
import { MODELS } from '../seedance/constants.js';
import { costFromTokens } from '../seedance/pricing.mjs';

const kindOf = (modelId) => MODELS.find((m) => m.id === modelId)?.kind ?? null;

export async function getApprovedModelIds(userId) {
    const sql = await getDb();
    if (!sql) return [];
    const rows = await sql`SELECT model_id FROM model_access_requests
        WHERE user_id = ${userId} AND status = 'approved'`;
    return rows.map((r) => r.model_id);
}

export async function getRequestsForUser(userId) {
    const sql = await getDb();
    if (!sql) return [];
    return sql`SELECT model_id, status FROM model_access_requests WHERE user_id = ${userId}`;
}

export async function requestAccess(userId, email, modelId, note) {
    const sql = await getDb();
    if (!sql) throw new Error('Access store unavailable');
    await sql`INSERT INTO model_access_requests (user_id, user_email, model_id, status, note, created_at)
        VALUES (${userId}, ${email}, ${modelId}, 'pending', ${note ?? null}, now())
        ON CONFLICT (user_id, model_id) DO UPDATE
        SET status = 'pending', note = ${note ?? null}, user_email = ${email},
            created_at = now(), decided_by = NULL, decided_at = NULL`;
}

export async function listRequests() {
    const sql = await getDb();
    if (!sql) return [];
    return sql`SELECT id, user_id, user_email, model_id, status, note, decided_by, created_at, decided_at
        FROM model_access_requests
        ORDER BY (status = 'pending') DESC, created_at DESC`;
}

export async function setRequestStatus(id, status, decidedBy) {
    const sql = await getDb();
    if (!sql) throw new Error('Access store unavailable');
    const rows = await sql`UPDATE model_access_requests
        SET status = ${status}, decided_by = ${decidedBy}, decided_at = now()
        WHERE id = ${id}
        RETURNING id, user_id, model_id, status`;
    return rows[0] ?? null;
}

export async function logUsage(e) {
    const sql = await getDb();
    if (!sql) return;
    try {
        await sql`INSERT INTO usage_events
            (user_id, user_email, model_id, resolution, duration, ratio, mode, has_video_input, task_id, status, est_cost_usd, created_at)
            VALUES (${e.userId}, ${e.email}, ${e.modelId}, ${e.resolution ?? null}, ${e.duration ?? null},
                    ${e.ratio ?? null}, ${e.mode ?? null}, ${e.hasVideoInput ?? false}, ${e.taskId ?? null},
                    'created', ${e.estCostUsd ?? null}, now())
            ON CONFLICT (task_id) DO NOTHING`;
    } catch (err) {
        console.error('[usage] log failed:', err.message); // best-effort; never blocks a generation
    }
}

// Finalize a usage row from the terminal task state. Reads the stored row so
// cost uses the resolution/video-input captured at creation. Idempotent and
// scoped to the owning user. Returns { taskId, status, costUsd } or null.
export async function finalizeUsage(taskId, userId, { status, completionTokens }) {
    const sql = await getDb();
    if (!sql) return null;
    const rows = await sql`SELECT model_id, resolution, has_video_input
        FROM usage_events WHERE task_id = ${taskId} AND user_id = ${userId}`;
    const row = rows[0];
    if (!row) return null;
    let costUsd = 0;
    if (status === 'succeeded') {
        const kind = kindOf(row.model_id);
        costUsd = kind && completionTokens != null && row.resolution
            ? costFromTokens(kind, row.resolution, row.has_video_input, completionTokens)
            : null;
    }
    await sql`UPDATE usage_events
        SET status = ${status}, completion_tokens = ${completionTokens ?? null},
            cost_usd = ${costUsd}, finalized_at = now()
        WHERE task_id = ${taskId} AND user_id = ${userId}`;
    return { taskId, status, costUsd };
}

// Admin aggregates. All-time (v1). Failed rows excluded from cost; est_cost_usd
// is the fallback when the actual cost was never finalized.
export async function getUsagePerUser() {
    const sql = await getDb();
    if (!sql) return [];
    return sql`SELECT user_id, user_email,
        count(*) FILTER (WHERE status <> 'failed') AS generations,
        coalesce(sum(coalesce(cost_usd, est_cost_usd)) FILTER (WHERE status <> 'failed'), 0) AS cost_usd
        FROM usage_events GROUP BY user_id, user_email ORDER BY cost_usd DESC`;
}

export async function getUsagePerUserModel() {
    const sql = await getDb();
    if (!sql) return [];
    return sql`SELECT user_id, model_id,
        count(*) FILTER (WHERE status <> 'failed') AS generations,
        coalesce(sum(coalesce(cost_usd, est_cost_usd)) FILTER (WHERE status <> 'failed'), 0) AS cost_usd
        FROM usage_events GROUP BY user_id, model_id`;
}
```

- [ ] **Step 2: Verify it imports (syntax check)**

Run: `node --check lib/access/db.js`
Expected: no output (valid syntax). (Runtime behavior is exercised by the routes in later tasks.)

- [ ] **Step 3: Commit**

```bash
git add lib/access/db.js
git commit -m "feat: Neon queries for model-access grants, requests, and usage"
```

---

## Phase 3 — Clerk auth wiring

### Task 7: Install Clerk, add provider + sign-in/up pages

**Files:**
- Modify: `package.json` (dependency), `app/layout.js`
- Create: `app/sign-in/[[...sign-in]]/page.jsx`, `app/sign-up/[[...sign-up]]/page.jsx`
- Create/modify: `.env.local` (developer adds keys — not committed)

**Interfaces:**
- Produces: `<ClerkProvider>` around the app; `/sign-in`, `/sign-up` routes.

- [ ] **Step 1: Install the SDK**

Run: `npm install @clerk/nextjs`
Expected: `@clerk/nextjs` added to `dependencies` in `package.json`.

- [ ] **Step 2: Add Clerk keys to `.env.local`** (developer step; obtain from Clerk dashboard)

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_xxx
CLERK_SECRET_KEY=sk_test_xxx
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
```

- [ ] **Step 3: Wrap the app in `<ClerkProvider>`**

Replace `app/layout.js` body with:

```jsx
import './globals.css';
import { Inter } from "next/font/google";
import { ClerkProvider } from '@clerk/nextjs';

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata = {
  title: 'Open Generative AI — Free AI Image & Video Studio',
  description: 'Generate AI images and videos using 200+ models — Flux, Midjourney, Kling, Veo, Seedance and more.',
};

export default function RootLayout({ children }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className={inter.variable}>{children}</body>
      </html>
    </ClerkProvider>
  );
}
```

- [ ] **Step 4: Create the sign-in page**

Create `app/sign-in/[[...sign-in]]/page.jsx`:

```jsx
import { SignIn } from '@clerk/nextjs';

export default function Page() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-black">
      <SignIn />
    </div>
  );
}
```

- [ ] **Step 5: Create the sign-up page**

Create `app/sign-up/[[...sign-up]]/page.jsx`:

```jsx
import { SignUp } from '@clerk/nextjs';

export default function Page() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-black">
      <SignUp />
    </div>
  );
}
```

- [ ] **Step 6: Verify the pages render**

Run: `npm run dev`, open `http://localhost:3001/sign-in`.
Expected: Clerk sign-in widget renders (no crash). `/sign-up` shows the sign-up widget.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json app/layout.js app/sign-in app/sign-up
git commit -m "feat: add Clerk provider and sign-in/sign-up pages"
```

---

### Task 8: Swap the middleware to clerkMiddleware

**Files:**
- Modify: `middleware.js` (full rewrite)

**Interfaces:**
- Consumes: Clerk `clerkMiddleware`, `createRouteMatcher`.
- Produces: unauthenticated web nav → 307 redirect to `/sign-in?redirect_url=...`; unauthenticated `/api/*` → 401 JSON; muapi rewrite preserved behind auth.

- [ ] **Step 1: Rewrite `middleware.js`**

Replace the entire file with:

```js
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

// Reachable without a session so the gate can be passed.
const isPublicRoute = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)']);

export default clerkMiddleware(async (auth, request) => {
    const { pathname, search } = request.nextUrl;

    if (isPublicRoute(request)) return NextResponse.next();

    // 1) Per-user auth gate.
    const { userId } = await auth();
    if (!userId) {
        if (pathname.startsWith('/api/')) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
        }
        const signIn = new URL('/sign-in', request.url);
        signIn.searchParams.set('redirect_url', pathname + search);
        return NextResponse.redirect(signIn, 307);
    }

    // 2) Existing muapi proxy logic (unchanged behaviour), now behind auth.
    const isMuApi =
        pathname.startsWith('/api/workflow') ||
        pathname.startsWith('/api/app') ||
        pathname.startsWith('/api/v1');
    if (isMuApi) {
        const isHandledByRoute =
            pathname.startsWith('/api/v1/creative-agent') ||
            pathname.startsWith('/api/v1/get_upload_url') ||
            pathname.startsWith('/api/v1/upload-binary');
        if (pathname.startsWith('/api/v1') && !isHandledByRoute) {
            const targetUrl = new URL(pathname + search, 'https://api.muapi.ai');
            return NextResponse.rewrite(targetUrl);
        }
    }

    return NextResponse.next();
});

// Run on every route except Next internals and the favicon.
export const config = {
    matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

- [ ] **Step 2: Verify the gate (manual)**

Run: `npm run dev`. In a private window (no Clerk session):
- Visit `http://localhost:3001/seedance` → redirects to `/sign-in?redirect_url=%2Fseedance`.
- `curl -i http://localhost:3001/api/access/me` → `HTTP/1.1 401`.

After signing in (allowlisted email), `/seedance` loads.

- [ ] **Step 3: Commit**

```bash
git add middleware.js
git commit -m "feat: replace shared-password gate with clerkMiddleware"
```

---

### Task 9: Remove the old shared-credential gate

**Files:**
- Delete: `lib/auth/credentials.js`, `app/api/auth/login/route.js`, `app/login/` (page + form), `lib/auth/publicPaths.js`
- Delete: `tests/auth-credentials.test.mjs`, `tests/auth-publicpaths.test.mjs`
- Check: no remaining imports of the deleted modules

- [ ] **Step 1: Confirm nothing else imports the old gate**

Run:
```bash
grep -rn "auth/credentials\|auth/publicPaths\|api/auth/login\|AUTH_COOKIE\|cookieMatches" app lib middleware.js --include="*.js" --include="*.jsx" --include="*.mjs" | grep -v node_modules
```
Expected: no matches (middleware.js was rewritten in Task 8). If any remain, resolve them before deleting.

- [ ] **Step 2: Delete the files**

```bash
git rm lib/auth/credentials.js lib/auth/publicPaths.js app/api/auth/login/route.js tests/auth-credentials.test.mjs tests/auth-publicpaths.test.mjs
git rm -r app/login
```

- [ ] **Step 3: Verify tests + build**

Run: `node --test tests/*.test.js tests/*.test.mjs`
Expected: PASS (the two deleted auth tests are gone; the rest pass).

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: remove shared-credential gate (replaced by Clerk)"
```

---

### Task 10: Server user helper

**Files:**
- Create: `lib/auth/user.js`

**Interfaces:**
- Consumes: Clerk `auth`, `currentUser` from `@clerk/nextjs/server`.
- Produces: `getUser() -> { userId, email, role } | null`; `isAdmin() -> boolean`.

- [ ] **Step 1: Write the module**

Create `lib/auth/user.js`:

```js
// Server-only. Resolves the current Clerk user + admin role. Reads role from
// currentUser().publicMetadata so no custom JWT session-claim template is needed.

import { auth, currentUser } from '@clerk/nextjs/server';

export async function getUser() {
    const { userId } = await auth();
    if (!userId) return null;
    const user = await currentUser();
    const email = user?.primaryEmailAddress?.emailAddress
        ?? user?.emailAddresses?.[0]?.emailAddress
        ?? null;
    const role = user?.publicMetadata?.role ?? null;
    return { userId, email, role };
}

export async function isAdmin() {
    const user = await getUser();
    return user?.role === 'admin';
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check lib/auth/user.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add lib/auth/user.js
git commit -m "feat: server getUser/isAdmin helpers backed by Clerk"
```

---

## Phase 4 — API routes

### Task 11: Access routes (`/api/access/me`, `/api/access/request`)

**Files:**
- Create: `app/api/access/me/route.js`, `app/api/access/request/route.js`

**Interfaces:**
- Consumes: `getUser`; `getApprovedModelIds`, `getRequestsForUser`, `requestAccess`; `MODELS`, `GATED_MODEL_IDS`.
- Produces: `GET /api/access/me -> { allowedModelIds, requests }`; `POST /api/access/request` `{ modelId, note }`.

- [ ] **Step 1: Write `/api/access/me`**

Create `app/api/access/me/route.js`:

```js
import { NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { getApprovedModelIds, getRequestsForUser } from '../../../../lib/access/db.js';
import { MODELS } from '../../../../lib/seedance/constants.js';

export const runtime = 'nodejs';

export async function GET() {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const approved = await getApprovedModelIds(user.userId);
    const openIds = MODELS.filter((m) => !m.gated).map((m) => m.id);
    const allowedModelIds = [...new Set([...openIds, ...approved])];
    const requests = await getRequestsForUser(user.userId);
    return NextResponse.json({ allowedModelIds, requests });
}
```

- [ ] **Step 2: Write `/api/access/request`**

Create `app/api/access/request/route.js`:

```js
import { NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { requestAccess } from '../../../../lib/access/db.js';
import { GATED_MODEL_IDS } from '../../../../lib/seedance/constants.js';

export const runtime = 'nodejs';

export async function POST(request) {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }); }
    const { modelId, note } = body || {};
    if (!GATED_MODEL_IDS.includes(modelId)) {
        return NextResponse.json({ error: 'That model does not require a request.' }, { status: 400 });
    }
    if (!user.email) return NextResponse.json({ error: 'No email on your account.' }, { status: 400 });
    await requestAccess(user.userId, user.email, modelId, typeof note === 'string' ? note.slice(0, 500) : null);
    return NextResponse.json({ ok: true, status: 'pending' });
}
```

- [ ] **Step 3: Verify (manual, signed in)**

Run: `npm run dev`; signed in, in the browser console:
```js
await (await fetch('/api/access/me')).json()
```
Expected: `{ allowedModelIds: [<mini id>, <fast id>], requests: [] }`. Then:
```js
await (await fetch('/api/access/request', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ modelId: '<full 2.0 id>' })})).json()
```
Expected: `{ ok: true, status: 'pending' }`; a re-fetch of `/api/access/me` shows the pending request.

- [ ] **Step 4: Commit**

```bash
git add app/api/access
git commit -m "feat: access API — list allowed models and request a gated model"
```

---

### Task 12: Enforce access + log usage in the ModelArk proxy

**Files:**
- Modify: `app/api/byteplus/[[...path]]/route.js` (POST handler + imports)

**Interfaces:**
- Consumes: `getUser`; `getApprovedModelIds`, `logUsage`; `MODELS`, `GATED_MODEL_IDS`; `canUseModel`; `estimateCost`.
- Produces: 403 on gated-model access without a grant; a `usage_events` row on successful create.

- [ ] **Step 1: Add imports at the top of the file**

After the existing header comment / `export const runtime`, add:

```js
import { getUser } from '../../../../lib/auth/user.js';
import { getApprovedModelIds, logUsage } from '../../../../lib/access/db.js';
import { MODELS, GATED_MODEL_IDS } from '../../../../lib/seedance/constants.js';
import { canUseModel } from '../../../../lib/access/decision.mjs';
import { estimateCost } from '../../../../lib/seedance/pricing.mjs';

const CREATE_TASK_PATH = 'contents/generations/tasks';

function hasVideoInput(content) {
    return Array.isArray(content) && content.some((c) => c?.type === 'video_url' || c?.role === 'reference_video');
}
```

- [ ] **Step 2: Replace the `POST` handler**

Replace the existing `POST` function with:

```js
export async function POST(request, { params }) {
    const headers = arkHeaders();
    if (!headers) return missingKeyResponse();
    const { path } = await params;
    const joined = (path || []).join('/');
    const body = await request.text();
    const targetUrl = buildTargetUrl(path, request.url);

    // Only the create-task path is gated + logged; all other paths forward as-is.
    if (joined !== CREATE_TASK_PATH) {
        try {
            return await forward(targetUrl, { method: 'POST', headers, body });
        } catch (error) {
            return NextResponse.json({ error: error.message }, { status: 502 });
        }
    }

    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    const modelId = parsed?.model;

    // Access check — only hit the DB for gated models.
    const approvedModelIds = GATED_MODEL_IDS.includes(modelId) ? await getApprovedModelIds(user.userId) : [];
    if (!canUseModel({ modelId, gatedModelIds: GATED_MODEL_IDS, approvedModelIds })) {
        return NextResponse.json(
            { error: 'You do not have access to this model. Request access from the model picker.' },
            { status: 403 },
        );
    }

    // Forward to ModelArk, then log usage on success (with the returned task id).
    let response;
    try {
        response = await fetch(targetUrl, { method: 'POST', headers, body });
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 502 });
    }
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }

    if (response.ok && data?.id) {
        const kind = MODELS.find((m) => m.id === modelId)?.kind ?? null;
        const withVideo = hasVideoInput(parsed?.content);
        await logUsage({
            userId: user.userId,
            email: user.email,
            modelId,
            resolution: parsed?.resolution ?? null,
            duration: typeof parsed?.duration === 'number' ? parsed.duration : null,
            ratio: parsed?.ratio ?? null,
            mode: request.headers.get('x-seedance-mode') || null,
            hasVideoInput: withVideo,
            taskId: data.id,
            estCostUsd: kind ? estimateCost({ kind, resolution: parsed?.resolution, duration: parsed?.duration, hasVideoInput: withVideo }) : null,
        });
    }

    return data
        ? NextResponse.json(data, { status: response.status })
        : NextResponse.json({ error: text.slice(0, 500) || response.statusText }, { status: response.status });
}
```

- [ ] **Step 3: Verify (manual)**

Run: `npm run dev`; signed in as a non-admin with no grant.
- In the studio, pick **Seedance 2.0 (full)** (Task 16 locks it in the UI, but the API guard is independent) and force a create-task POST — expect `403` with the access message.
- Generate with **Mini** — succeeds, and a row appears:
```bash
psql "$DATABASE_URL" -c "SELECT model_id, resolution, est_cost_usd, status FROM usage_events ORDER BY created_at DESC LIMIT 1;"
```
Expected: one `created` row with a non-null `est_cost_usd`.

- [ ] **Step 4: Commit**

```bash
git add app/api/byteplus/[[...path]]/route.js
git commit -m "feat: gate the create-task proxy by model access and log usage"
```

---

### Task 13: Usage finalize route

**Files:**
- Create: `app/api/usage/complete/route.js`

**Interfaces:**
- Consumes: `getUser`; `finalizeUsage`.
- Produces: `POST /api/usage/complete { taskId }` → finalizes the row from the terminal task state.

- [ ] **Step 1: Write the route**

Create `app/api/usage/complete/route.js`:

```js
import { NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { finalizeUsage } from '../../../../lib/access/db.js';

export const runtime = 'nodejs';
const ARK_BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3';

// Finalize a usage row once its task reaches a terminal state. Re-fetches the
// task from ModelArk (server key) so completion_tokens is authoritative — the
// client is never trusted for token counts. Idempotent; no-op for non-terminal,
// unknown, or foreign tasks.
export async function POST(request) {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ ok: false }, { status: 200 }); }
    const taskId = body?.taskId;
    if (!taskId) return NextResponse.json({ ok: false }, { status: 200 });

    const key = process.env.ARK_API_KEY;
    if (!key) return NextResponse.json({ ok: false }, { status: 200 });

    let task;
    try {
        const r = await fetch(`${ARK_BASE}/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
            headers: { Authorization: `Bearer ${key}` },
        });
        task = await r.json();
    } catch {
        return NextResponse.json({ ok: false }, { status: 200 });
    }

    const status = (task?.status || '').toLowerCase();
    if (status === 'succeeded') {
        const tokens = task?.usage?.completion_tokens ?? null;
        const result = await finalizeUsage(taskId, user.userId, { status: 'succeeded', completionTokens: tokens });
        return NextResponse.json({ ok: true, status: 'succeeded', costUsd: result?.costUsd ?? null });
    }
    if (status === 'failed' || status === 'cancelled' || status === 'canceled' || status === 'expired') {
        await finalizeUsage(taskId, user.userId, { status: 'failed', completionTokens: null });
        return NextResponse.json({ ok: true, status: 'failed' });
    }
    return NextResponse.json({ ok: true, status: status || 'pending' }); // not terminal — no-op
}
```

- [ ] **Step 2: Verify (manual)**

After a Mini generation completes (Task 16 wires the auto-ping), the row finalizes:
```bash
psql "$DATABASE_URL" -c "SELECT status, completion_tokens, cost_usd FROM usage_events ORDER BY created_at DESC LIMIT 1;"
```
Expected: `status = succeeded`, `cost_usd` populated (non-null).

- [ ] **Step 3: Commit**

```bash
git add app/api/usage/complete
git commit -m "feat: finalize usage cost from the terminal task state"
```

---

### Task 14: Admin routes

**Files:**
- Create: `app/api/admin/requests/route.js`, `app/api/admin/requests/[id]/approve/route.js`, `app/api/admin/requests/[id]/revoke/route.js`, `app/api/admin/usage/route.js`

**Interfaces:**
- Consumes: `getUser`, `isAdmin`; `listRequests`, `setRequestStatus`, `getUsagePerUser`, `getUsagePerUserModel`; `nextStatus`.
- Produces: admin-only list/approve/revoke/usage endpoints (403 for non-admins).

- [ ] **Step 1: List requests**

Create `app/api/admin/requests/route.js`:

```js
import { NextResponse } from 'next/server';
import { isAdmin } from '../../../../lib/auth/user.js';
import { listRequests } from '../../../../lib/access/db.js';

export const runtime = 'nodejs';

export async function GET() {
    if (!(await isAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    return NextResponse.json({ requests: await listRequests() });
}
```

- [ ] **Step 2: Approve**

Create `app/api/admin/requests/[id]/approve/route.js`:

```js
import { NextResponse } from 'next/server';
import { getUser, isAdmin } from '../../../../../../lib/auth/user.js';
import { setRequestStatus } from '../../../../../../lib/access/db.js';
import { nextStatus } from '../../../../../../lib/access/requestStatus.mjs';

export const runtime = 'nodejs';

export async function POST(_request, { params }) {
    const admin = await getUser();
    if (!admin || admin.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const { id } = await params;
    const row = await setRequestStatus(Number(id), nextStatus('approve'), admin.email);
    if (!row) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    return NextResponse.json({ ok: true, request: row });
}
```

- [ ] **Step 3: Revoke**

Create `app/api/admin/requests/[id]/revoke/route.js` (identical except the action):

```js
import { NextResponse } from 'next/server';
import { getUser } from '../../../../../../lib/auth/user.js';
import { setRequestStatus } from '../../../../../../lib/access/db.js';
import { nextStatus } from '../../../../../../lib/access/requestStatus.mjs';

export const runtime = 'nodejs';

export async function POST(_request, { params }) {
    const admin = await getUser();
    if (!admin || admin.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const { id } = await params;
    const row = await setRequestStatus(Number(id), nextStatus('revoke'), admin.email);
    if (!row) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    return NextResponse.json({ ok: true, request: row });
}
```

- [ ] **Step 4: Usage aggregates**

Create `app/api/admin/usage/route.js`:

```js
import { NextResponse } from 'next/server';
import { isAdmin } from '../../../../lib/auth/user.js';
import { getUsagePerUser, getUsagePerUserModel } from '../../../../lib/access/db.js';

export const runtime = 'nodejs';

export async function GET() {
    if (!(await isAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const [perUser, perUserModel] = await Promise.all([getUsagePerUser(), getUsagePerUserModel()]);
    return NextResponse.json({ perUser, perUserModel });
}
```

- [ ] **Step 5: Verify (manual)**

As a non-admin: `curl -i` (with session cookie) `/api/admin/requests` → `403`.
As an admin (set `publicMetadata.role='admin'` in Clerk dashboard): same → `200` with the pending request from Task 11. POST to `/api/admin/requests/<id>/approve` → `{ ok: true }`; re-fetch `/api/access/me` as that user shows the model approved.

- [ ] **Step 6: Commit**

```bash
git add app/api/admin
git commit -m "feat: admin API — list/approve/revoke requests and usage aggregates"
```

---

## Phase 5 — Frontend

### Task 15: Admin page

**Files:**
- Create: `app/admin/page.jsx`, `app/admin/AdminClient.jsx`

**Interfaces:**
- Consumes: `isAdmin`; `/api/admin/requests`, `/api/admin/requests/[id]/approve|revoke`, `/api/admin/usage`.

- [ ] **Step 1: Server page (admin gate)**

Create `app/admin/page.jsx`:

```jsx
import { notFound } from 'next/navigation';
import { isAdmin } from '../../lib/auth/user.js';
import AdminClient from './AdminClient.jsx';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  if (!(await isAdmin())) notFound();
  return <AdminClient />;
}
```

- [ ] **Step 2: Client island (tables + actions)**

Create `app/admin/AdminClient.jsx`:

```jsx
'use client';
import { useEffect, useState, useCallback } from 'react';

export default function AdminClient() {
  const [requests, setRequests] = useState([]);
  const [usage, setUsage] = useState({ perUser: [], perUserModel: [] });
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    const [r, u] = await Promise.all([
      fetch('/api/admin/requests').then((x) => x.json()),
      fetch('/api/admin/usage').then((x) => x.json()),
    ]);
    setRequests(r.requests || []);
    setUsage({ perUser: u.perUser || [], perUserModel: u.perUserModel || [] });
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (id, action) => {
    setBusy(id);
    await fetch(`/api/admin/requests/${id}/${action}`, { method: 'POST' });
    setBusy(null);
    load();
  };

  return (
    <div className="min-h-screen bg-black text-white p-8 space-y-10">
      <section>
        <h1 className="text-xl font-semibold mb-4">Access requests</h1>
        <table className="w-full text-sm border-collapse">
          <thead className="text-white/50 text-left">
            <tr><th className="py-2">User</th><th>Model</th><th>Status</th><th>Note</th><th></th></tr>
          </thead>
          <tbody>
            {requests.map((q) => (
              <tr key={q.id} className="border-t border-white/10">
                <td className="py-2">{q.user_email}</td>
                <td>{q.model_id}</td>
                <td>{q.status}</td>
                <td className="text-white/60">{q.note || '—'}</td>
                <td className="text-right space-x-2">
                  {q.status !== 'approved' && (
                    <button disabled={busy === q.id} onClick={() => act(q.id, 'approve')}
                      className="px-3 py-1 rounded bg-primary text-black text-xs font-semibold disabled:opacity-50">Approve</button>
                  )}
                  {q.status !== 'revoked' && (
                    <button disabled={busy === q.id} onClick={() => act(q.id, 'revoke')}
                      className="px-3 py-1 rounded bg-white/10 text-xs disabled:opacity-50">Revoke</button>
                  )}
                </td>
              </tr>
            ))}
            {!requests.length && <tr><td colSpan={5} className="py-4 text-white/40">No requests yet.</td></tr>}
          </tbody>
        </table>
      </section>

      <section>
        <h1 className="text-xl font-semibold mb-4">Usage & cost (all-time)</h1>
        <table className="w-full text-sm border-collapse">
          <thead className="text-white/50 text-left">
            <tr><th className="py-2">User</th><th>Generations</th><th>Cost (USD)</th></tr>
          </thead>
          <tbody>
            {usage.perUser.map((u) => (
              <tr key={u.user_id} className="border-t border-white/10">
                <td className="py-2">{u.user_email}</td>
                <td>{u.generations}</td>
                <td>${Number(u.cost_usd).toFixed(2)}</td>
              </tr>
            ))}
            {!usage.perUser.length && <tr><td colSpan={3} className="py-4 text-white/40">No usage yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Verify (manual)**

As an admin, visit `http://localhost:3001/admin` → sees the requests + usage tables; Approve/Revoke buttons update the row. As a non-admin, `/admin` → 404.

- [ ] **Step 4: Commit**

```bash
git add app/admin
git commit -m "feat: admin page — requests approval + per-user usage/cost"
```

---

### Task 16: Studio picker gating, mode header, and completion ping

**Files:**
- Modify: `lib/seedance/client.js` (`createTask`, `pollTask` already return `raw`)
- Modify: `app/seedance/SeedanceStudio.jsx` (fetch access, thread `allowedModelIds`, ping complete in `watchJob`, pass mode to `createTask`)
- Modify: `app/seedance/PromptBar.jsx` (lock gated models + request action)

**Interfaces:**
- Consumes: `/api/access/me`, `/api/access/request`, `/api/usage/complete`.
- Produces: locked gated models with a "Request access" action; usage cost auto-finalized on task completion; `x-seedance-mode` sent on create.

- [ ] **Step 1: Send the mode header from `createTask`**

In `lib/seedance/client.js`, change `postJson` and `createTask` to accept extra headers:

```js
async function postJson(path, body, extraHeaders = {}) {
    let res;
    try {
        res = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...extraHeaders },
            body: JSON.stringify(body),
        });
    } catch {
        throw networkError();
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(extractError(data, `Request failed (${res.status})`));
    return data;
}

// Create a generation task. Returns the task id. `mode` is logged for usage.
export async function createTask(payload, mode) {
    const data = await postJson(TASKS_PATH, payload, mode ? { 'x-seedance-mode': mode } : {});
    const id = data?.id;
    if (!id) throw new Error('ModelArk did not return a task id.');
    return id;
}
```

- [ ] **Step 2: Pass the mode at the `createTask` call site**

In `app/seedance/SeedanceStudio.jsx`, `launchJob` calls `createTask(payload)`. Change it to pass the mode captured in `creation`:

```js
const taskId = await createTask(payload, creation.modeId ?? modeId);
```

- [ ] **Step 3: Ping usage-complete when a job reaches a terminal state**

In `app/seedance/SeedanceStudio.jsx` `watchJob`, add the fire-and-forget ping in both the success and error handlers. Replace the `.then(...).catch(...)` block with:

```js
        .then(({ url }) => {
            patchJob(jobId, { status: 'done', videoUrl: url });
            archiveJob(jobId, taskId, url);
            fetch('/api/usage/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId }),
            }).catch(() => {}); // best-effort cost finalization
        })
        .catch((e) => {
            patchJob(jobId, { status: 'error', error: e.message });
            fetch('/api/usage/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId }),
            }).catch(() => {}); // marks the row failed (cost 0)
        })
```

- [ ] **Step 4: Fetch the user's allowed models on mount**

In `app/seedance/SeedanceStudio.jsx`, add state + effect near the other `useState` hooks:

```js
    const [allowedModelIds, setAllowedModelIds] = useState(null); // null = loading; then string[]

    useEffect(() => {
        let alive = true;
        fetch('/api/access/me')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (alive && d) setAllowedModelIds(d.allowedModelIds); })
            .catch(() => {});
        return () => { alive = false; };
    }, []);
```

- [ ] **Step 5: Thread `allowedModelIds` into PromptBar**

In `app/seedance/SeedanceStudio.jsx`, find where `<PromptBar ... models={MODELS} />` is rendered (around line 724) and add both props (`setNotice` is the existing notice setter from `useState`, needed by the request action in Step 6):

```jsx
                models={MODELS}
                allowedModelIds={allowedModelIds}
                setNotice={setNotice}
```

If `setNotice` is already passed to `PromptBar`, don't duplicate it — just add `allowedModelIds`.

- [ ] **Step 6: Lock gated models + request action in PromptBar**

In `app/seedance/PromptBar.jsx`, the model `PillSelect` (around line 522) currently maps `models` to plain options. Replace that `PillSelect` with a version that disables gated-locked models and, when a locked model is chosen, posts a request instead of selecting it:

```jsx
                        <PillSelect
                            id="model" openKey={openKey} setOpenKey={setOpenKey}
                            display={selectedModel?.name || 'Model'} label="Model" value={options.model}
                            options={models.map((m) => {
                                const locked = m.gated && allowedModelIds && !allowedModelIds.includes(m.id);
                                return { value: m.id, label: locked ? `${m.name} 🔒 (request access)` : m.name, disabled: locked };
                            })}
                            onSelect={(v) => {
                                const m = models.find((x) => x.id === v);
                                const locked = m?.gated && allowedModelIds && !allowedModelIds.includes(v);
                                if (locked) {
                                    fetch('/api/access/request', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ modelId: v }),
                                    }).then(() => setNotice?.('Access requested — pending admin approval.')).catch(() => {});
                                    return;
                                }
                                setOpt('model', v);
                            }}
                        />
```

Ensure `PromptBar`'s props include `allowedModelIds` and (if not already) `setNotice`. If `PillSelect` does not support a `disabled` option flag, render locked entries as selectable but intercept in `onSelect` (above) — the interception already prevents selecting them, so `disabled` is cosmetic.

- [ ] **Step 7: Verify (manual, end-to-end)**

Run: `npm run dev`.
1. As a non-admin with no grant, the picker shows **Seedance 2.0 🔒 (request access)**; clicking it shows "Access requested — pending admin approval."
2. As admin at `/admin`, approve it.
3. Back as the user (reload), the model is selectable; generating with it succeeds and logs a `succeeded` usage row with `cost_usd`.
4. `/admin` usage table shows the generation and its cost.

- [ ] **Step 8: Commit**

```bash
git add lib/seedance/client.js app/seedance/SeedanceStudio.jsx app/seedance/PromptBar.jsx
git commit -m "feat: studio model gating, request-access action, usage cost finalization"
```

---

## Final verification

- [ ] **Full test suite**

Run: `node --test tests/*.test.js tests/*.test.mjs`
Expected: PASS — the remaining original tests (the two deleted auth test files aside) plus the 11 new ones (`accessDecision` 4 + `pricing` 5 + `requestStatus` 2).

- [ ] **Build**

Run: `npm run build`
Expected: build succeeds (Clerk env vars present in `.env.local`).

- [ ] **Manual smoke (recorded in Task 16 Step 7)** — request → approve → generate → cost shows in admin.

---

## Self-review notes (traceability to spec)

- Auth replace + allowlist + admin role → Tasks 7, 8, 9, 10 (allowlist is a Clerk dashboard setting; admin via `publicMetadata.role`).
- Model tiers / gating → Tasks 1, 2; enforced in Task 12.
- Request/approve/revoke → Tasks 6, 11, 14; UI in 15, 16.
- Usage + real cost → Tasks 3, 5, 6, 12, 13; UI in 15.
- Pricing reference numbers → Task 3 `RATES`/`EXAMPLE_5S`.
- Electron out of scope → untouched (no Vite/electron files in any task).
