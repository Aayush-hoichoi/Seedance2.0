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

- Multi-user accounts, roles, signup, or password reset — single shared credential.
- **Persistent sessions.** No signed-token session, no signing secret, no 7-day
  "remember me", no logout button. A successful login sets a plain browser-session
  cookie that is cleared when the browser closes; you log in again next time.
- Protecting the Electron desktop build. Electron runs the vite static bundle
  (`src/`, `index.html`) and does **not** execute Next.js middleware. It is a
  local app with the user's own key and is explicitly out of scope.
- Rotating the Seedance key in code. Key rotation is an ops step (swap
  `ARK_API_KEY` in `.env.local` / the deploy env); no code depends on its value.

## Approach: branded login + minimal hashed cookie (no session)

On successful login the server sets an **httpOnly, SameSite=Lax browser-session
cookie** named `ll_auth` whose value is the SHA-256 hex of `username:password`.
There is **no `maxAge`/`expires`**, so the browser drops it on close → re-login.

Middleware computes the expected hash from the env credentials and compares it to
the cookie on every non-public request. No database, no third-party auth, no
signing secret, no expiry logic — just a shared credential gate.

Why hash the creds rather than store a flag or the raw password: the cookie is a
bearer value; hashing keeps the plaintext password out of the cookie while still
being deterministically verifiable in Edge middleware. It is forgeable only by
someone who already knows the credentials (who could just log in anyway).

## Components

### 1. `lib/auth/credentials.js` (Edge-compatible)

Uses Web Crypto (`crypto.subtle`) only, so the same module works in both the Edge
middleware and Node route handlers. No Node `crypto` import. SHA-256 via
`crypto.subtle.digest` is async, so these helpers are async.

- `getAuthConfig()` → reads + validates env at call time; throws a clear error if
  `APP_AUTH_USERNAME` or `APP_AUTH_PASSWORD` is missing.
- `cookieValueFor(user, pass)` → `sha256Hex(`${user}:${pass}`)`.
- `expectedCookieValue()` → `cookieValueFor(APP_AUTH_USERNAME, APP_AUTH_PASSWORD)`.
- `cookieMatches(value)` → length-safe equality of `value` vs `expectedCookieValue()`
  (compare every char, no early return) so the gate check has no trivial timing leak.
- `credentialsMatch(user, pass)` → length-safe compare of submitted creds vs env.

Constant: cookie name `ll_auth`.

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

- `POST` only. Parse + validate body (`username`, `password` non-empty strings;
  otherwise `400`).
- If `credentialsMatch` → set `ll_auth` cookie = `cookieValueFor(user, pass)`:
  `httpOnly`, `sameSite: 'lax'`, `path: '/'`, **no `maxAge`/`expires`**
  (browser-session cookie), `secure` only when `NODE_ENV === 'production'` (so
  http://localhost dev works). Return `{ success: true }`.
- Else → `await` a small fixed delay (~400ms) to blunt brute-forcing, return
  `401 { success: false, error: 'Invalid credentials' }`.
- Missing auth env → `500 { success: false, error: 'Auth not configured' }` plus a
  server-side `console.error`.

### 4. `middleware.js` (extended, existing proxy preserved)

Runs auth **before** the existing muapi proxy logic.

- Public allowlist (bypass auth): `/login`, `/api/auth/login`, `/_next/*`,
  `/favicon.ico`, and static asset extensions. Next internals are already
  excluded by the matcher.
- Otherwise: read `ll_auth`; if `cookieMatches(value)` is false:
  - request path starts with `/api/` → return `401` JSON.
  - else → `307` redirect to `/login?next=<pathname+search>`.
- If valid → fall through to existing muapi rewrite logic, then
  `NextResponse.next()`.
- Middleware function stays `async` (hashing is async). Fail closed: if auth env
  is missing or hashing throws, treat as unauthenticated.
- Matcher widened to run on all routes except static files, e.g.
  `'/((?!_next/static|_next/image|favicon.ico).*)'`, while keeping behavior for
  the existing `/api/*` proxy paths.

> No logout route and no logout button — closing the browser ends the session.

## Env vars (added to `.env.local` and documented in README)

```
APP_AUTH_USERNAME=LoglineAI
APP_AUTH_PASSWORD=LoglineAI
```

No signing secret. If either is missing, the login route returns `500` and
middleware treats all requests as unauthenticated (fail closed).

## Error handling

- Invalid creds → inline form error + `401`.
- Missing auth env → `500` from login route, fail-closed in middleware, clear
  server log.
- Missing/forged/mismatched cookie → treated as unauthenticated (redirect or
  `401`), never a crash.
- `next` redirect param sanitized to same-origin relative paths only.

## Security notes

- Cookie is `httpOnly` (no JS access) and holds a hash, not the plaintext password.
- `secure` in production so the cookie isn't sent over plain HTTP.
- Length-safe comparisons for both submitted creds and the cookie value.
- Failed-login delay to slow brute force (single shared credential).
- This is a shared-credential gate, not per-user auth — adequate for "lock the URL
  before sharing", not for untrusted public exposure. The cookie is a bearer value
  (replayable while valid), which is acceptable given httpOnly + Secure.

## Testing

- **Unit (`lib/auth/credentials.js`)**: `cookieValueFor` deterministic + matches
  known SHA-256; `cookieMatches` true for expected value, false for tampered;
  `credentialsMatch` true/false cases; missing env throws.
- **Integration (login route)**: `401` on bad creds and no cookie set; `200` +
  `Set-Cookie: ll_auth=...` (no `Max-Age`) on good creds; missing env → `500`.
- **E2E (Playwright)**: logged-out visit to `/seedance` → redirect to `/login`;
  successful login → lands on `/seedance`; `fetch('/api/seedance/prompts')` with no
  cookie → `401`; clearing cookies (simulating browser close) → back to `/login`.

## Out-of-band ops step (reminder, not code)

Rotate the Seedance 2.0 key: replace `ARK_API_KEY` in `.env.local` and in the
deployment environment, then restart. No code change required.
