# Login Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock the hosted Next.js Seedance app behind one shared username/password (`LoglineAI`/`LoglineAI` from env), with a branded `/login` page and no persistent session.

**Architecture:** A framework-agnostic `lib/auth/credentials.js` (Web Crypto only, runs in both Edge middleware and Node route handlers) computes `sha256("user:pass")`. The login route sets that hash as an httpOnly browser-session cookie `ll_auth` (no expiry). `middleware.js` compares the cookie to the env-derived hash on every non-public request — redirecting page requests to `/login` and returning `401` for `/api/*`. No signing secret, no session store, no logout.

**Tech Stack:** Next.js (App Router) middleware + route handlers, React client component for the form, Web Crypto (`crypto.subtle`), Node built-in test runner (`node --test`), curl for integration checks.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `lib/auth/credentials.js` (create) | Pure auth helpers: hash, env config, credential + cookie comparison. The only unit-tested unit. |
| `tests/auth-credentials.test.mjs` (create) | Unit tests for the above (`node --test`). |
| `app/api/auth/login/route.js` (create) | Thin POST handler: validate body → check creds → set/deny cookie. |
| `middleware.js` (modify) | Add the auth gate before the existing muapi proxy logic; widen the matcher. |
| `app/login/page.js` (create) | Branded login page shell. |
| `app/login/LoginForm.jsx` (create) | Client form: posts creds, shows errors, redirects on success. |
| `.env.local` (modify) | Add `APP_AUTH_USERNAME` / `APP_AUTH_PASSWORD`. |
| `README.md` (modify) | Document the gate + Seedance key rotation. |

Convention notes (verified in repo): `lib/*` files are ESM `.js` (`export const …`); Node 24 auto-detects ESM syntax so `tests/*.test.mjs` can `import` them via `node --test`. `next/server` is NOT importable under plain `node`, so route/middleware are verified with curl, not unit tests. Relative imports are the repo convention (no `@/` alias used in `app/seedance`).

---

### Task 1: Auth credentials module (TDD)

**Files:**
- Create: `lib/auth/credentials.js`
- Test: `tests/auth-credentials.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/auth-credentials.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AUTH_COOKIE,
    sha256Hex,
    cookieValueFor,
    safeEqual,
    getAuthConfig,
    expectedCookieValue,
    credentialsMatch,
    cookieMatches,
} from '../lib/auth/credentials.js';

test('AUTH_COOKIE name', () => {
    assert.equal(AUTH_COOKIE, 'll_auth');
});

test('sha256Hex matches a known vector (echo -n "abc" | shasum -a 256)', async () => {
    assert.equal(
        await sha256Hex('abc'),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
});

test('cookieValueFor is 64-hex of user:pass and deterministic', async () => {
    const v = await cookieValueFor('LoglineAI', 'LoglineAI');
    assert.match(v, /^[0-9a-f]{64}$/);
    assert.equal(v, await sha256Hex('LoglineAI:LoglineAI'));
});

test('safeEqual compares values without type coercion surprises', () => {
    assert.equal(safeEqual('a', 'a'), true);
    assert.equal(safeEqual('a', 'b'), false);
    assert.equal(safeEqual('a', 'aa'), false);
    assert.equal(safeEqual('a', 1), false);
});

test('getAuthConfig throws when env is unset', () => {
    delete process.env.APP_AUTH_USERNAME;
    delete process.env.APP_AUTH_PASSWORD;
    assert.throws(() => getAuthConfig(), /Auth not configured/);
});

test('credentialsMatch true/false with env set', () => {
    process.env.APP_AUTH_USERNAME = 'LoglineAI';
    process.env.APP_AUTH_PASSWORD = 'LoglineAI';
    assert.equal(credentialsMatch('LoglineAI', 'LoglineAI'), true);
    assert.equal(credentialsMatch('LoglineAI', 'wrong'), false);
    assert.equal(credentialsMatch('nope', 'LoglineAI'), false);
    assert.equal(credentialsMatch('', ''), false);
});

test('cookieMatches: expected value passes, anything else fails', async () => {
    process.env.APP_AUTH_USERNAME = 'LoglineAI';
    process.env.APP_AUTH_PASSWORD = 'LoglineAI';
    const good = await expectedCookieValue();
    assert.equal(await cookieMatches(good), true);
    assert.equal(await cookieMatches('deadbeef'), false);
    assert.equal(await cookieMatches(''), false);
    assert.equal(await cookieMatches(undefined), false);
});

test('cookieMatches fails closed when unconfigured', async () => {
    delete process.env.APP_AUTH_USERNAME;
    delete process.env.APP_AUTH_PASSWORD;
    assert.equal(await cookieMatches('whatever'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/auth-credentials.test.mjs`
Expected: FAIL — `Cannot find module '../lib/auth/credentials.js'` (or import resolution error).

- [ ] **Step 3: Write minimal implementation**

Create `lib/auth/credentials.js`:

```js
// Shared-credential auth gate. Web Crypto only (no Node-specific APIs) so this
// module runs unchanged in Edge middleware and Node route handlers.
//
// No sessions, no signing secret: the cookie value is sha256("username:password")
// and is compared against the same hash derived from env on every request.

export const AUTH_COOKIE = 'll_auth';

// SHA-256 hex of a string using Web Crypto (available in Edge + Node 18+).
export async function sha256Hex(input) {
    const data = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

// Deterministic cookie value for a credential pair.
export async function cookieValueFor(username, password) {
    return sha256Hex(`${username}:${password}`);
}

// Reads + validates the configured credentials. Throws if unset (fail closed).
export function getAuthConfig() {
    const username = process.env.APP_AUTH_USERNAME;
    const password = process.env.APP_AUTH_PASSWORD;
    if (!username || !password) {
        throw new Error(
            'Auth not configured: set APP_AUTH_USERNAME and APP_AUTH_PASSWORD',
        );
    }
    return { username, password };
}

// The cookie value a logged-in browser should carry, derived from env.
export async function expectedCookieValue() {
    const { username, password } = getAuthConfig();
    return cookieValueFor(username, password);
}

// Length-checked equality that compares every character (no early-return on
// first mismatch) to avoid trivial timing leaks. Returns false for non-strings.
export function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

// True if submitted credentials match the configured ones. Throws if unset.
export function credentialsMatch(username, password) {
    const cfg = getAuthConfig();
    const u = safeEqual(username ?? '', cfg.username);
    const p = safeEqual(password ?? '', cfg.password);
    return u && p;
}

// True if a cookie value matches the env-derived hash. Never throws — returns
// false (fail closed) when the cookie is missing or auth is unconfigured.
export async function cookieMatches(value) {
    if (!value) return false;
    try {
        return safeEqual(value, await expectedCookieValue());
    } catch {
        return false;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/auth-credentials.test.mjs`
Expected: PASS — `pass 8`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/auth/credentials.js tests/auth-credentials.test.mjs
git commit -m "feat: add shared-credential auth helpers (hash, compare, env config)"
```

---

### Task 2: Add login credentials to env

**Files:**
- Modify: `.env.local`

- [ ] **Step 1: Append the credentials**

Add to the end of `.env.local` (these are server-side only, never `NEXT_PUBLIC_`):

```
# App login gate (single shared credential) - server-side only
APP_AUTH_USERNAME=LoglineAI
APP_AUTH_PASSWORD=LoglineAI
```

- [ ] **Step 2: Verify Next picks them up**

Run (one-off): `node -e "require('fs'); const t=require('fs').readFileSync('.env.local','utf8'); console.log(/APP_AUTH_USERNAME=LoglineAI/.test(t) && /APP_AUTH_PASSWORD=LoglineAI/.test(t) ? 'OK' : 'MISSING')"`
Expected: `OK`

- [ ] **Step 3: Commit**

`.env.local` is gitignored (verify with `git check-ignore .env.local` → prints the path). Do NOT force-add it. Instead record the requirement so it survives:

This is covered by the README task (Task 6). No commit here. Note for the operator: ensure these two vars are also set in the deployment environment.

---

### Task 3: Login API route

**Files:**
- Create: `app/api/auth/login/route.js`

- [ ] **Step 1: Write the route**

Create `app/api/auth/login/route.js`:

```js
import { NextResponse } from 'next/server';
import {
    AUTH_COOKIE,
    cookieValueFor,
    credentialsMatch,
} from '../../../../lib/auth/credentials.js';

export const runtime = 'nodejs';

const FAIL_DELAY_MS = 400; // blunt brute-forcing of the single shared credential
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function POST(request) {
    let body;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json(
            { success: false, error: 'Invalid request body' },
            { status: 400 },
        );
    }

    const { username, password } = body || {};
    if (
        typeof username !== 'string' ||
        typeof password !== 'string' ||
        !username ||
        !password
    ) {
        return NextResponse.json(
            { success: false, error: 'Username and password are required' },
            { status: 400 },
        );
    }

    let ok;
    try {
        ok = credentialsMatch(username, password);
    } catch (err) {
        console.error('[auth] login route misconfigured:', err.message);
        return NextResponse.json(
            { success: false, error: 'Auth not configured' },
            { status: 500 },
        );
    }

    if (!ok) {
        await delay(FAIL_DELAY_MS);
        return NextResponse.json(
            { success: false, error: 'Invalid credentials' },
            { status: 401 },
        );
    }

    const res = NextResponse.json({ success: true });
    res.cookies.set(AUTH_COOKIE, await cookieValueFor(username, password), {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
        // No maxAge/expires → browser-session cookie (cleared on browser close).
    });
    return res;
}
```

- [ ] **Step 2: Start the dev server (background) for verification**

Run: `npm run dev` (leave running; default port 3000). Wait until it logs `Ready` / `compiled`.

- [ ] **Step 3: Verify good credentials set the cookie**

Run:
```bash
curl -i -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"LoglineAI","password":"LoglineAI"}' | grep -iE 'HTTP/|set-cookie'
```
Expected: `HTTP/1.1 200 OK` and a `Set-Cookie: ll_auth=<64 hex>; Path=/; HttpOnly; SameSite=Lax` line (no `Max-Age`/`Expires`).

- [ ] **Step 4: Verify bad credentials are rejected with no cookie**

Run:
```bash
curl -i -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"LoglineAI","password":"nope"}' | grep -iE 'HTTP/|set-cookie'
```
Expected: `HTTP/1.1 401 Unauthorized` and NO `Set-Cookie` line (after a ~400ms pause).

- [ ] **Step 5: Commit**

```bash
git add app/api/auth/login/route.js
git commit -m "feat: add login route that sets the auth cookie on valid credentials"
```

---

### Task 4: Gate all routes in middleware

**Files:**
- Modify: `middleware.js` (full rewrite of the file — existing proxy logic preserved inside)

- [ ] **Step 1: Rewrite middleware.js**

Replace the entire contents of `middleware.js` with:

```js
import { NextResponse } from 'next/server';
import { AUTH_COOKIE, cookieMatches } from './lib/auth/credentials.js';

// Paths reachable WITHOUT auth (otherwise the gate could never be passed).
const PUBLIC_PREFIXES = ['/login', '/api/auth/'];
// Static-ish assets we never gate (defensive; the matcher already drops _next).
const STATIC_FILE_RE =
    /\.(?:png|jpe?g|gif|svg|webp|ico|css|js|map|txt|woff2?|ttf|eot)$/i;

function isPublicPath(pathname) {
    if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) {
        return true;
    }
    return STATIC_FILE_RE.test(pathname);
}

export async function middleware(request) {
    const url = request.nextUrl;
    const { pathname, search } = url;

    // 1) Auth gate (skip public paths).
    if (!isPublicPath(pathname)) {
        const cookie = request.cookies.get(AUTH_COOKIE)?.value;
        const authed = await cookieMatches(cookie);
        if (!authed) {
            if (pathname.startsWith('/api/')) {
                return NextResponse.json(
                    { success: false, error: 'Unauthorized' },
                    { status: 401 },
                );
            }
            const loginUrl = new URL('/login', url);
            loginUrl.searchParams.set('next', pathname + search);
            return NextResponse.redirect(loginUrl, 307);
        }
    }

    // 2) Existing muapi proxy logic (unchanged behaviour).
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
}

// Run on every route except Next internals and the favicon.
export const config = {
    matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

- [ ] **Step 2: Verify an unauthenticated page redirects to /login**

With the dev server running:
```bash
curl -i -s http://localhost:3000/seedance | grep -iE 'HTTP/|location'
```
Expected: `HTTP/1.1 307 Temporary Redirect` and `location: /login?next=%2Fseedance` (or `/login?next=/seedance`).

- [ ] **Step 3: Verify an unauthenticated API call returns 401**

```bash
curl -i -s http://localhost:3000/api/seedance/prompts | grep -iE 'HTTP/'
```
Expected: `HTTP/1.1 401 Unauthorized`.

- [ ] **Step 4: Verify a logged-in cookie passes the gate**

```bash
curl -s -c /tmp/lljar -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"LoglineAI","password":"LoglineAI"}' >/dev/null
curl -i -s -b /tmp/lljar http://localhost:3000/seedance | grep -iE 'HTTP/'
curl -i -s -b /tmp/lljar http://localhost:3000/api/seedance/prompts | grep -iE 'HTTP/'
```
Expected: `/seedance` → `HTTP/1.1 200 OK`; `/api/seedance/prompts` → `HTTP/1.1 200 OK` (or its normal status, not 401).

- [ ] **Step 5: Verify /login itself is reachable while logged out**

```bash
curl -i -s http://localhost:3000/login | grep -iE 'HTTP/'
```
Expected: `HTTP/1.1 200 OK` (not a redirect loop).

- [ ] **Step 6: Commit**

```bash
git add middleware.js
git commit -m "feat: gate all routes behind the auth cookie, preserve muapi proxy"
```

---

### Task 5: Branded login page

**Files:**
- Create: `app/login/page.js`
- Create: `app/login/LoginForm.jsx`

- [ ] **Step 1: Create the client form**

Create `app/login/LoginForm.jsx`:

```jsx
'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

// Only allow same-origin relative redirect targets (defends against open-redirect).
function safeNext(next) {
    if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) {
        return next;
    }
    return '/seedance';
}

export default function LoginForm() {
    const router = useRouter();
    const params = useSearchParams();
    const next = safeNext(params.get('next'));

    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    async function onSubmit(event) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });
            if (res.ok) {
                router.push(next);
                router.refresh();
                return;
            }
            const data = await res.json().catch(() => ({}));
            setError(
                data.error === 'Auth not configured'
                    ? 'Login is not configured on the server.'
                    : 'Incorrect username or password.',
            );
        } catch {
            setError('Network error. Please try again.');
        } finally {
            setBusy(false);
        }
    }

    return (
        <form
            onSubmit={onSubmit}
            className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.03] p-8 backdrop-blur-xl"
        >
            <div className="mb-6 text-center">
                <h1 className="text-2xl font-extrabold tracking-tight text-white">
                    Logline<span className="text-[#22d3ee]">AI</span>
                </h1>
                <p className="mt-1 text-sm text-white/40">Sign in to continue</p>
            </div>

            <label className="mb-3 block">
                <span className="mb-1.5 block text-xs font-medium text-white/50">Username</span>
                <input
                    type="text"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none transition-colors focus:border-[#22d3ee]/60"
                    required
                />
            </label>

            <label className="mb-4 block">
                <span className="mb-1.5 block text-xs font-medium text-white/50">Password</span>
                <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none transition-colors focus:border-[#22d3ee]/60"
                    required
                />
            </label>

            {error && (
                <p className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                    {error}
                </p>
            )}

            <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-[#22d3ee] px-4 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
                {busy ? 'Signing in…' : 'Sign in'}
            </button>
        </form>
    );
}
```

- [ ] **Step 2: Create the page shell**

Create `app/login/page.js`:

```js
import { Suspense } from 'react';
import LoginForm from './LoginForm.jsx';

export const metadata = {
    title: 'Sign in · LoglineAI',
};

export default function LoginPage() {
    return (
        <main className="flex min-h-screen w-full items-center justify-center bg-[#050505] px-4">
            <Suspense fallback={null}>
                <LoginForm />
            </Suspense>
        </main>
    );
}
```

(The `Suspense` boundary is required because `LoginForm` uses `useSearchParams`.)

- [ ] **Step 3: Verify the page renders and the flow works in a browser**

With the dev server running, open `http://localhost:3000/seedance` in a browser.
Expected sequence:
1. Redirected to `http://localhost:3000/login?next=/seedance`, branded "LoglineAI" card visible.
2. Submit wrong password → inline "Incorrect username or password." error, stays on page.
3. Submit `LoglineAI` / `LoglineAI` → lands on `/seedance`, studio loads, history/prompts load (no 401s in the network tab).

Use the `/verify` skill (or Playwright MCP) to drive this and capture a screenshot of the login page and the loaded studio.

- [ ] **Step 4: Commit**

```bash
git add app/login/page.js app/login/LoginForm.jsx
git commit -m "feat: add branded LoglineAI login page"
```

---

### Task 6: Document the gate + key rotation, final smoke

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document env + rotation in README**

Add a short "Access control" section to `README.md` (place it near the existing environment/setup docs):

```markdown
## Access control (login gate)

The hosted app is gated by a single shared credential. Set these server-side env
vars (e.g. in `.env.local` and in your deployment environment):

```
APP_AUTH_USERNAME=LoglineAI
APP_AUTH_PASSWORD=LoglineAI
```

Visitors are redirected to `/login`; `/api/*` returns `401` without a valid
cookie. The cookie is a browser-session cookie (no expiry) — closing the browser
logs you out. There is no signing secret and no server-side session store.

Scope: this protects the Next.js hosted deployment only. The Electron desktop
build (vite bundle) does not run Next middleware and is not gated.

### Rotating the Seedance 2.0 key

To rotate the BytePlus ModelArk key, replace `ARK_API_KEY` in `.env.local` and in
the deployment environment, then restart the app. No code change is required.
```

- [ ] **Step 2: Run the full automated test suite**

Run: `node --test tests/`
Expected: all existing tests plus `tests/auth-credentials.test.mjs` pass (`fail 0`).

- [ ] **Step 3: Final end-to-end smoke (fresh cookie jar)**

With the dev server running:
```bash
rm -f /tmp/lljar
echo "1) logged-out page:"   ; curl -i -s http://localhost:3000/        | grep -iE 'HTTP/|location'
echo "2) logged-out api:"    ; curl -i -s http://localhost:3000/api/seedance/prompts | grep -iE 'HTTP/'
echo "3) login:"             ; curl -i -s -c /tmp/lljar -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"LoglineAI","password":"LoglineAI"}' | grep -iE 'HTTP/|set-cookie'
echo "4) authed page:"       ; curl -i -s -b /tmp/lljar http://localhost:3000/seedance | grep -iE 'HTTP/'
echo "5) authed api:"        ; curl -i -s -b /tmp/lljar http://localhost:3000/api/seedance/prompts | grep -iE 'HTTP/'
```
Expected: (1) 307 → `/login?next=/`, (2) 401, (3) 200 + `Set-Cookie: ll_auth=…`, (4) 200, (5) 200.

- [ ] **Step 4: Stop the dev server and commit**

```bash
git add README.md
git commit -m "docs: document login gate env vars and Seedance key rotation"
```

---

## Self-Review

**Spec coverage:**
- Branded `/login` page → Task 5. ✓
- No session/secret/expiry/logout → cookie has no `maxAge`; no `APP_AUTH_SECRET`; no logout route/button anywhere. ✓
- `ll_auth = sha256(user:pass)` httpOnly cookie → Task 1 (`cookieValueFor`) + Task 3 (set). ✓
- Middleware gates pages (redirect) and `/api/*` (401), preserves muapi proxy → Task 4. ✓
- Env `APP_AUTH_USERNAME`/`APP_AUTH_PASSWORD`, no secret → Tasks 2 + 6. ✓
- Fail-closed on missing env → `getAuthConfig` throws; `cookieMatches` catches → false; login route returns 500. ✓ (Tasks 1, 3, 4)
- `next` open-redirect sanitization → `safeNext` (Task 5) + middleware only ever sets a relative `next`. ✓
- Length-safe compare + failed-login delay → `safeEqual` (Task 1) + `FAIL_DELAY_MS` (Task 3). ✓
- Electron out of scope; Seedance key rotation as ops step → Task 6 README. ✓
- Tests: unit (Task 1), integration via curl (Tasks 3, 4, 6), browser E2E (Task 5). ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every verification step has exact command + expected output.

**Type/name consistency:** `AUTH_COOKIE` ('ll_auth'), `cookieValueFor`, `credentialsMatch`, `cookieMatches`, `expectedCookieValue`, `getAuthConfig`, `safeEqual`, `sha256Hex` — names identical across Tasks 1, 3, 4. Import paths checked: route `../../../../lib/auth/credentials.js`, middleware `./lib/auth/credentials.js`, test `../lib/auth/credentials.js`.
