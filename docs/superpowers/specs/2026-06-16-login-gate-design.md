# Login gate for the LoglineAI / Seedance web app

**Date:** 2026-06-16
**Status:** Approved (design) — pending implementation plan

## Problem

The Seedance studio is a hosted Next.js app whose `/api/*` routes spend a paid
BytePlus ModelArk (Seedance 2.0) key. Sharing the URL today means anyone with the
link can drive generations and burn the key. We need to lock the whole app behind
a single shared login before sharing it, and separately rotate the Seedance key.

## Goal

Gate the entire hosted Next.js deployment behind one shared credential
(`LoglineAI` / `LoglineAI`, read from env). Unauthenticated browsers are
redirected to a branded `/login` page; unauthenticated `/api/*` requests return
`401`, so a leaked URL cannot be used to spend the key.

## Non-goals

- Multi-user accounts, roles, signup, or password reset — this is a single shared
  credential gate.
- Protecting the Electron desktop build. Electron runs the vite static bundle
  (`src/`, `index.html`) and does **not** execute Next.js middleware. It is a
  local app with the user's own key and is explicitly out of scope.
- Rotating the Seedance key in code. Key rotation is an ops step (swap
  `ARK_API_KEY` in `.env.local` / the deploy env); no code depends on its value.

## Approach: signed-cookie session

On successful login the server sets an **httpOnly, SameSite=Lax** cookie named
`ll_session` whose value is a signed token:

```
base64url(JSON({ exp })) + "." + base64url(HMAC-SHA256(payload, APP_AUTH_SECRET))
```

Middleware verifies the signature and expiry on every non-public request. No
database and no third-party auth provider — just a shared credential gate with a
tamper-proof cookie.

Why a signed cookie (not HTTP Basic Auth): the user chose a branded `/login`
experience with a logout affordance. Why not a server session store: a single
shared credential needs no per-user state; a signed token is stateless and
Edge-verifiable.

## Components

### 1. `lib/auth/session.js` (Edge-compatible)

Uses Web Crypto (`crypto.subtle`) only, so the same module works in both the Edge
middleware and Node route handlers. No Node `crypto` import.

- `createSessionToken({ ttlMs })` → signed token string.
- `verifySessionToken(token)` → `boolean` (valid signature **and** not expired;
  any malformed input returns `false`, never throws).
- `credentialsMatch(user, pass)` → `boolean`, compared against
  `APP_AUTH_USERNAME` / `APP_AUTH_PASSWORD` with a length-safe equality check
  (compare every char, no early return) to avoid trivial timing leaks.
- `getAuthConfig()` → reads + validates env at call time; throws a clear error if
  `APP_AUTH_USERNAME`, `APP_AUTH_PASSWORD`, or `APP_AUTH_SECRET` is missing.

Constants: cookie name `ll_session`, default TTL 7 days.

### 2. `app/login/page.js` + `app/login/LoginForm.jsx`

- `page.js`: server component shell, centered card, branded "LoglineAI" wordmark,
  uses the existing dark/glass aesthetic (`--glass-bg`, Inter, `#050505` bg).
- `LoginForm.jsx`: `'use client'`. Username + password inputs, submit button.
  POSTs JSON `{ username, password }` to `/api/auth/login`. On `200` →
  `router.push(next || '/seedance')`. On `401` → inline error
  ("Incorrect username or password."). Disables the button while submitting.
  Reads `next` from `useSearchParams()` and only honors same-origin relative
  paths (must start with `/` and not `//`) to avoid open-redirect.

### 3. `app/api/auth/login/route.js` (Node runtime)

- `POST` only. Parse + validate body (`username`, `password` are non-empty
  strings; reject otherwise with `400`).
- If `credentialsMatch` → set `ll_session` cookie: `httpOnly`, `sameSite: 'lax'`,
  `path: '/'`, `maxAge` = 7 days, `secure` only when `NODE_ENV === 'production'`
  (so http://localhost dev works). Return `{ success: true }`.
- Else → `await` a small fixed delay (~400ms) to blunt brute-forcing, return
  `401 { success: false, error: 'Invalid credentials' }`.
- Missing auth env → `500` with `{ success: false, error: 'Auth not configured' }`
  and a server-side `console.error`.

### 4. `app/api/auth/logout/route.js` (Node runtime)

- `POST` → clear `ll_session` (set empty, `maxAge: 0`), return `{ success: true }`.

### 5. `middleware.js` (extended, existing proxy preserved)

Runs auth **before** the existing muapi proxy logic.

- Public allowlist (bypass auth): `/login`, `/api/auth/login`, `/api/auth/logout`,
  `/_next/*`, `/favicon.ico`, and static asset extensions. Next internals are
  already excluded by the matcher.
- Otherwise: read `ll_session`; if `verifySessionToken` is false:
  - request path starts with `/api/` → return `401` JSON.
  - else → `307` redirect to `/login?next=<pathname+search>`.
- If valid → fall through to existing muapi rewrite logic, then
  `NextResponse.next()`.
- Middleware function becomes `async` (HMAC verify is async).
- Matcher widened to run on all routes except static files, e.g.
  `'/((?!_next/static|_next/image|favicon.ico).*)'`, while keeping behavior for
  the existing `/api/*` proxy paths.

### 6. Logout button in `app/seedance/SeedanceStudio.jsx`

In the top-left header cluster (next to "Seedance 2.0 · BytePlus ModelArk",
around line 538): a small "Log out" button matching the existing button styling.
On click → `POST /api/auth/logout` then `window.location.assign('/login')`.

## Env vars (added to `.env.local` and documented in README)

```
APP_AUTH_USERNAME=LoglineAI
APP_AUTH_PASSWORD=LoglineAI
APP_AUTH_SECRET=<64-char random hex>   # cookie signing key; required
```

If any is missing, the login route returns `500` and middleware treats all
sessions as invalid (fail closed).

## Error handling

- Invalid creds → inline form error + `401`.
- Missing auth env → `500` from login route, fail-closed in middleware, clear
  server log.
- Expired/tampered/missing cookie → treated as unauthenticated (redirect or
  `401`), never a crash.
- `next` redirect param sanitized to same-origin relative paths only.

## Security notes

- Cookie is `httpOnly` (no JS access) + signed (can't be forged without
  `APP_AUTH_SECRET`).
- `secure` in production so the cookie isn't sent over plain HTTP.
- Length-safe credential comparison.
- Failed-login delay to slow brute force (single shared credential, so this is a
  meaningful mitigation).
- This is a shared-credential gate, not per-user auth — adequate for "lock the URL
  before sharing", not for untrusted public exposure.

## Testing

- **Unit (`lib/auth/session.js`)**: sign→verify round-trip; tampered token
  rejected; expired token rejected; malformed input returns false; credential
  compare true/false cases.
- **Integration (route handlers)**: login `401` on bad creds and no cookie set;
  login `200` + `Set-Cookie` on good creds; logout clears cookie; missing env →
  `500`.
- **E2E (Playwright)**: logged-out visit to `/seedance` → redirect to `/login`;
  successful login → lands on `/seedance`; logout → back to `/login`;
  `fetch('/api/seedance/prompts')` with no cookie → `401`.

## Out-of-band ops step (reminder, not code)

Rotate the Seedance 2.0 key: replace `ARK_API_KEY` in `.env.local` and in the
deployment environment, then restart. No code change required.
