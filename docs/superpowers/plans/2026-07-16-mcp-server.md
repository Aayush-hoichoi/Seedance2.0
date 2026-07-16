# MCP Server (Full Studio Parity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose every studio capability as a remote MCP server at `/api/mcp/mcp` so Claude clients (claude.ai, Claude Desktop, Claude Code) act as the signed-in Clerk user with identical permissions, gating, quotas, and usage attribution.

**Architecture:** Streamable-HTTP MCP endpoint inside this Next.js app via `mcp-handler`, authenticated by Clerk OAuth (`@clerk/mcp-tools`). Tools live in small `lib/mcp/tools/*.js` modules and call the same `lib/` functions the HTTP routes use; the two governed create paths (video proxy, image enqueue) are extracted from their routes into `lib/gateway/` so route + MCP share one implementation.

**Tech Stack:** Next.js 15 App Router (JS, no TypeScript), `mcp-handler`, `@clerk/mcp-tools`, `@clerk/nextjs` v7, `zod@^3`, Neon Postgres, `node --test`.

**Spec:** `docs/superpowers/specs/2026-07-16-mcp-server-design.md`

## Global Constraints

- NEVER add `"type": "module"` to package.json (breaks the build — see repo memory). New pure modules use `.mjs`; Next-only modules may use `.js` with ESM imports.
- Tests run with: `node --test tests/*.test.js tests/*.test.mjs`. Test files may ONLY import modules that do not pull in `@clerk/nextjs`, `next/server`, or `@neondatabase/serverless` — put pure logic in `.mjs` files with no framework imports.
- Relative imports only (no `@/` alias — the repo doesn't configure one).
- Immutability: spread, never mutate. Files ≤ ~400 lines. No `console.log` in production code (`console.error` for server errors matches repo idiom).
- All new tool inputs validated with zod at the boundary. Never trust tool args.
- No hardcoded secrets; env vars only (`ARK_API_KEY`, `ARK_AK`, `ARK_SK`, `CLERK_SECRET_KEY`, `KEY_ENCRYPTION_KEY` already exist).
- Commit after every task (conventional commits, no attribution footer). Do NOT push unless asked; if asked, push to `feat/clerk-model-access`, not `main`.
- Error responses from gateway libs use `apiError(code, message, detail)` → JSON `{ code, message, ...detail }` (`lib/gateway/httpError.mjs:19`). Tool errors must surface `code` + `message`.

## File Structure (locked in)

```
app/api/mcp/[transport]/route.js            MCP endpoint (auth wrapper + tool registration only)
app/.well-known/oauth-protected-resource/mcp/route.js   OAuth resource metadata
lib/auth/shape.mjs                          pure: Clerk user object → { userId, email, role }
lib/auth/user.js                            + getUserById(userId)
lib/gateway/authz.js                        split: gatewayContextFor(user, opts) + gatewayContext(opts)
lib/gateway/videoCreate.mjs                 extracted governed video create (from byteplus route)
lib/gateway/enqueue.mjs                     extracted image/gateway enqueue (from generations route)
lib/seedance/galleryItem.mjs                extracted toItem/presignKey (from gallery route)
lib/byteplus/assetsServer.js                server-side Asset Library calls (signAssetRequest direct)
lib/byteplus/uploadUrl.js                   extracted presigned-PUT logic (from upload route)
lib/mcp/register.js                         registerTool wrapper, ToolError, toolGatewayCtx
lib/mcp/schemas.mjs                         pure: zod shapes + TOOL_PERMISSIONS map (node-testable)
lib/mcp/videoContent.mjs                    pure: prompt+refs → ModelArk content array (node-testable)
lib/mcp/tools/catalog.js                    list_models, get_my_access, request_model_access
lib/mcp/tools/projects.js                   list_projects, create_project, update_project
lib/mcp/tools/history.js                    list_generations, get_generation, browse_gallery, bin_generation, like_generation
lib/mcp/tools/assets.js                     list_assets, delete_asset, create_upload_url, register_asset
lib/mcp/tools/generate.js                   create_video, create_image, get_job_status, cancel_job
lib/mcp/tools/admin.js                      get_usage, list_access_requests, resolve_access_request, list_quotas, set_quota, view_audit
tests/mcpSchemas.test.mjs, tests/videoContent.test.mjs, tests/galleryItem.test.mjs, tests/shapeUser.test.mjs
docs/mcp.md                                 connector setup + tool reference
```

---

### Task 1: Dependencies, MCP skeleton, OAuth metadata, middleware

**Files:**
- Modify: `package.json` (deps)
- Create: `app/api/mcp/[transport]/route.js`
- Create: `app/.well-known/oauth-protected-resource/mcp/route.js`
- Modify: `middleware.js:8`

**Interfaces:**
- Produces: authenticated MCP endpoint at `POST /api/mcp/mcp`; tool callbacks receive `extra.authInfo.extra.userId` (Clerk user id). Later tasks add `register*Tools(server)` calls inside `createMcpHandler`.

- [ ] **Step 1: Install dependencies**

```bash
npm install mcp-handler @clerk/mcp-tools zod@^3
```
Expected: package.json gains the three deps; `npm ls zod` resolves without peer warnings.

- [ ] **Step 2: Create the well-known OAuth metadata route**

```js
// app/.well-known/oauth-protected-resource/mcp/route.js
import { protectedResourceHandlerClerk, metadataCorsOptionsRequestHandler } from '@clerk/mcp-tools/next';

// OAuth 2.0 Protected Resource Metadata (RFC 9728): tells MCP clients that
// Clerk is the authorization server for the /api/mcp/mcp resource.
const handler = protectedResourceHandlerClerk({ scopes_supported: ['email', 'profile'] });
const corsHandler = metadataCorsOptionsRequestHandler();

export { handler as GET, corsHandler as OPTIONS };
```

- [ ] **Step 3: Create the MCP endpoint with a ping tool**

```js
// app/api/mcp/[transport]/route.js
import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { auth } from '@clerk/nextjs/server';
import { verifyClerkToken } from '@clerk/mcp-tools/next';

export const runtime = 'nodejs';
export const maxDuration = 300; // register_asset polls; video status may sweep

const handler = createMcpHandler(
    (server) => {
        server.tool('ping', 'Connectivity check — returns pong and your user id.', {}, async (_args, extra) => ({
            content: [{ type: 'text', text: JSON.stringify({ pong: true, userId: extra?.authInfo?.extra?.userId ?? null }) }],
        }));
    },
    {},
    { basePath: '/api/mcp' }, // endpoint: /api/mcp/mcp (streamable HTTP)
);

const verify = async (_req, token) => {
    const clerkAuth = await auth({ acceptsToken: 'oauth_token' });
    return verifyClerkToken(clerkAuth, token);
};

const authHandler = withMcpAuth(handler, verify, {
    required: true,
    resourceMetadataPath: '/.well-known/oauth-protected-resource/mcp',
});

export { authHandler as GET, authHandler as POST };
```

- [ ] **Step 4: Make both paths public in middleware**

Modify `middleware.js:8` — add the two matchers:

```js
const isPublicRoute = createRouteMatcher(['/', '/sign-in(.*)', '/sign-up(.*)', '/api/webhooks(.*)', '/api/cron(.*)', '/api/mcp(.*)', '/.well-known(.*)']);
```
(They are public to the session gate only — `withMcpAuth` enforces OAuth on every MCP call.)

- [ ] **Step 5: Verify with curl**

```bash
npm run dev &
sleep 8
curl -s http://localhost:3000/.well-known/oauth-protected-resource/mcp | head -c 400; echo
curl -s -o /dev/null -w '%{http_code} %{header_json}' -X POST http://localhost:3000/api/mcp/mcp \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```
Expected: metadata JSON contains `authorization_servers` pointing at your Clerk domain; the POST returns **401** with a `WWW-Authenticate` header containing `resource_metadata=".../.well-known/oauth-protected-resource/mcp"`. If `verifyClerkToken` or `withMcpAuth` import names differ in the installed versions, check `node_modules/@clerk/mcp-tools/dist/next.d.ts` and `node_modules/mcp-handler/dist/index.d.ts` and use the exported names found there (Clerk renamed `experimental_withMcpAuth` → mcp-handler's `withMcpAuth` in mid-2025; the doc source of truth is https://clerk.com/docs/nextjs/guides/ai/mcp/build-mcp-server).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json app/api/mcp app/.well-known middleware.js
git commit -m "feat: MCP endpoint skeleton — Clerk OAuth-protected /api/mcp/mcp with ping tool"
```

---

### Task 2: Resolve users from OAuth tokens

**Files:**
- Create: `lib/auth/shape.mjs`
- Modify: `lib/auth/user.js`
- Modify: `lib/gateway/authz.js:15-44` (split, body unchanged)
- Test: `tests/shapeUser.test.mjs`

**Interfaces:**
- Produces: `shapeUser(clerkUser) → { userId, email, role } | null` (pure); `getUserById(userId) → Promise<{ userId, email, role } | null>`; `gatewayContextFor(user, { projectId, permission }) → { ok, ctx | response }` — same contract as `gatewayContext` but takes the user explicitly. All MCP tools consume these.

- [ ] **Step 1: Write the failing test**

```js
// tests/shapeUser.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeUser } from '../lib/auth/shape.mjs';

test('shapeUser maps a Clerk backend user to { userId, email, role }', () => {
    const u = {
        id: 'user_123',
        primaryEmailAddress: { emailAddress: 'a@hoichoi.tv' },
        emailAddresses: [{ emailAddress: 'b@hoichoi.tv' }],
        publicMetadata: { role: 'admin' },
    };
    assert.deepEqual(shapeUser(u), { userId: 'user_123', email: 'a@hoichoi.tv', role: 'admin' });
});

test('shapeUser falls back to first email and null role, and returns null for null', () => {
    const u = { id: 'user_9', emailAddresses: [{ emailAddress: 'x@y.z' }], publicMetadata: {} };
    assert.deepEqual(shapeUser(u), { userId: 'user_9', email: 'x@y.z', role: null });
    assert.equal(shapeUser(null), null);
});
```

- [ ] **Step 2: Run it — must fail** — `node --test tests/shapeUser.test.mjs` → FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// lib/auth/shape.mjs — pure mapping, shared by session and OAuth-token paths.
export function shapeUser(u) {
    if (!u) return null;
    const email = u.primaryEmailAddress?.emailAddress
        ?? u.emailAddresses?.[0]?.emailAddress
        ?? null;
    return { userId: u.id, email, role: u.publicMetadata?.role ?? null };
}
```

Rewrite `lib/auth/user.js` to reuse it and add `getUserById`:

```js
// Server-only. Resolves the current Clerk user + admin role. Reads role from
// publicMetadata so no custom JWT session-claim template is needed.
import { auth, currentUser, clerkClient } from '@clerk/nextjs/server';
import { shapeUser } from './shape.mjs';

export async function getUser() {
    const { userId } = await auth();
    if (!userId) return null;
    return shapeUser(await currentUser());
}

// OAuth-token path (MCP): same shape, resolved via the backend API.
export async function getUserById(userId) {
    if (!userId) return null;
    try {
        const client = await clerkClient();
        return shapeUser(await client.users.getUser(userId));
    } catch (error) {
        console.error('[auth] getUserById failed:', error.message);
        return null;
    }
}

export async function isAdmin() {
    const user = await getUser();
    return user?.role === 'admin';
}
```

Split `lib/gateway/authz.js`: rename the existing `gatewayContext` to `gatewayContextFor(user, { projectId = null, permission = null } = {})`, delete its first three lines (`getUser()` call + null-check — keep the `getDb()` check), and add a thin wrapper with the old name so all existing routes keep working:

```js
export async function gatewayContext({ projectId = null, permission = null } = {}) {
    const user = await getUser();
    if (!user) return { ok: false, response: apiError('UNAUTHORIZED', 'Sign in required.') };
    return gatewayContextFor(user, { projectId, permission });
}

export async function gatewayContextFor(user, { projectId = null, permission = null } = {}) {
    const sql = await getDb();
    if (!sql) return { ok: false, response: apiError('DB_UNAVAILABLE', 'Database is not configured.') };
    // ...everything from the current function body after the getUser() check,
    // UNCHANGED (roles, project membership, permission check, ctx return).
}
```
Also export `gatewayContextFor`. Do not alter any logic inside the moved body.

- [ ] **Step 4: Run tests** — `node --test tests/*.test.js tests/*.test.mjs` → all PASS (new + existing).

- [ ] **Step 5: Verify no route broke** — `npm run build` → compiles. `grep -rn "gatewayContext(" app | wc -l` unchanged call sites.

- [ ] **Step 6: Commit** — `git commit -m "feat: getUserById + gatewayContextFor — resolve gateway context from an OAuth userId"`

---

### Task 3: Tool registration helper + schemas module

**Files:**
- Create: `lib/mcp/register.js`
- Create: `lib/mcp/schemas.mjs`
- Test: `tests/mcpSchemas.test.mjs`

**Interfaces:**
- Consumes: `getUserById` (Task 2), `gatewayContextFor` (Task 2).
- Produces: `registerTool(server, { name, description, schema, run })` where `run({ user, args }) → any` (JSON-serialized into MCP text content; throw `ToolError(code, message)` for friendly failures); `toolGatewayCtx(user, { projectId, permission }) → ctx` (throws ToolError on denial); `TOOL_PERMISSIONS` map + zod shapes in `schemas.mjs`. Every tool task consumes these.

- [ ] **Step 1: Write the failing test**

```js
// tests/mcpSchemas.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { TOOL_PERMISSIONS, createVideoShape, refsShape } from '../lib/mcp/schemas.mjs';

test('every generation/asset tool requires generation.create; usage tools require usage.view', () => {
    for (const t of ['create_video', 'create_image', 'list_assets', 'register_asset', 'create_upload_url', 'delete_asset']) {
        assert.equal(TOOL_PERMISSIONS[t], 'generation.create', t);
    }
    assert.equal(TOOL_PERMISSIONS.get_usage, 'usage.view');
    assert.equal(TOOL_PERMISSIONS.resolve_access_request, 'model.grant');
    assert.equal(TOOL_PERMISSIONS.set_quota, 'quota.manage');
    assert.equal(TOOL_PERMISSIONS.view_audit, 'audit.view');
});

test('create_video shape validates refs and rejects junk', () => {
    const S = z.object(createVideoShape);
    const ok = S.safeParse({ model: 'seedance-2.0-mini', prompt: 'a cat', refs: [{ assetId: '123', role: 'first_frame' }] });
    assert.equal(ok.success, true);
    assert.equal(S.safeParse({ model: 'seedance-2.0-mini' }).success, false); // prompt required
    const badRole = z.object({ refs: z.array(z.object(refsShape)) }).safeParse({ refs: [{ url: 'https://x/y.png', role: 'banana' }] });
    assert.equal(badRole.success, false);
});
```

- [ ] **Step 2: Run — FAIL** (`lib/mcp/schemas.mjs` not found).

- [ ] **Step 3: Implement schemas.mjs (pure — no framework imports)**

```js
// lib/mcp/schemas.mjs — zod raw shapes + the tool → permission map.
// Pure module: node --test runs it directly.
import { z } from 'zod';

export const REF_ROLES = ['first_frame', 'last_frame', 'reference_image', 'reference_video'];

export const refsShape = {
    assetId: z.string().max(64).optional(),
    url: z.string().url().max(2000).optional(),
    role: z.enum(REF_ROLES),
};

export const createVideoShape = {
    projectId: z.number().int().positive().optional(),
    model: z.string().min(1).max(100),
    prompt: z.string().min(1).max(5000),
    mode: z.string().max(50).optional(),
    resolution: z.string().max(10).optional(),
    duration: z.number().int().min(1).max(30).optional(),
    ratio: z.string().max(10).optional(),
    refs: z.array(z.object(refsShape)).max(4).optional(),
};

export const createImageShape = {
    projectId: z.number().int().positive(),
    model: z.string().min(1).max(100),
    prompt: z.string().min(1).max(5000),
    imageCount: z.number().int().min(1).max(4).optional(),
    aspectRatio: z.string().max(10).optional(),
    imageSize: z.enum(['1K', '2K', '4K']).optional(),
    refs: z.array(z.object(refsShape)).max(3).optional(),
};

// Tool → gateway permission. null = any signed-in user (membership still scopes data).
export const TOOL_PERMISSIONS = {
    ping: null,
    list_models: null, get_my_access: null, request_model_access: null,
    list_projects: null, create_project: 'project.manage', update_project: 'project.manage',
    list_generations: null, get_generation: null, browse_gallery: null,
    bin_generation: null, like_generation: null,
    list_assets: 'generation.create', delete_asset: 'generation.create',
    register_asset: 'generation.create', create_upload_url: 'generation.create',
    create_video: 'generation.create', create_image: 'generation.create',
    get_job_status: null, cancel_job: null,
    get_usage: 'usage.view',
    list_access_requests: 'model.grant', resolve_access_request: 'model.grant',
    list_quotas: 'quota.manage', set_quota: 'quota.manage',
    view_audit: 'audit.view',
};
```

- [ ] **Step 4: Implement register.js**

```js
// lib/mcp/register.js — every MCP tool goes through here: resolve the Clerk
// user from the OAuth token, validate, run, JSON-serialize, format errors.
import { getUserById } from '../auth/user.js';
import { gatewayContextFor } from '../gateway/authz.js';

export class ToolError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function textResult(value) {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(code, message) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }] };
}

export function registerTool(server, { name, description, schema = {}, run }) {
    server.tool(name, description, schema, async (args, extra) => {
        const userId = extra?.authInfo?.extra?.userId ?? null;
        const user = await getUserById(userId);
        if (!user) return errorResult('UNAUTHORIZED', 'Could not resolve your account from the OAuth token.');
        try {
            return textResult(await run({ user, args: args ?? {} }));
        } catch (error) {
            if (error instanceof ToolError) return errorResult(error.code, error.message);
            console.error(`[mcp:${name}]`, error);
            return errorResult('TOOL_FAILED', 'The tool failed unexpectedly — try again or check the studio.');
        }
    });
}

// Gateway context for a tool call; throws a ToolError carrying the gateway's
// own code/message so denials read exactly like the studio's.
export async function toolGatewayCtx(user, { projectId = null, permission = null } = {}) {
    const auth = await gatewayContextFor(user, { projectId, permission });
    if (!auth.ok) {
        const body = await auth.response.json().catch(() => ({}));
        throw new ToolError(body.code ?? 'FORBIDDEN', body.message ?? body.error ?? 'Not allowed.');
    }
    return auth.ctx;
}
```

- [ ] **Step 5: Run tests** — `node --test tests/mcpSchemas.test.mjs` → PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat: MCP tool registry — registerTool wrapper, ToolError, schemas + permission map"`

---

### Task 4: Catalog & access tools

**Files:**
- Create: `lib/mcp/tools/catalog.js`
- Modify: `app/api/mcp/[transport]/route.js` (register)

**Interfaces:**
- Consumes: `registerTool`, `ToolError` (Task 3); `MODELS`, `IMAGE_MODELS`, `GATED_MODEL_IDS`, `IMAGE_GATED_MODEL_IDS` from `lib/seedance/constants.js`; `getApprovedModelIds`, `getRequestsForUser`, `getMonthSpendUsd`, `requestAccess` from `lib/access/db.js`; `notifySlackAccessRequested` from `lib/notify/slack.mjs`; `getDb` from `lib/db/neon.js`.
- Produces: `registerCatalogTools(server)`.

- [ ] **Step 1: Implement**

```js
// lib/mcp/tools/catalog.js — list_models, get_my_access, request_model_access.
import { z } from 'zod';
import { registerTool, ToolError } from '../register.js';
import { MODELS, IMAGE_MODELS, GATED_MODEL_IDS, IMAGE_GATED_MODEL_IDS } from '../../seedance/constants.js';
import { getApprovedModelIds, getRequestsForUser, getMonthSpendUsd, requestAccess } from '../../access/db.js';
import { notifySlackAccessRequested } from '../../notify/slack.mjs';
import { getDb } from '../../db/neon.js';

async function allowedIdsFor(userId) {
    const approved = await getApprovedModelIds(userId);
    const openIds = [...MODELS, ...IMAGE_MODELS].filter((m) => !m.gated).map((m) => m.id);
    return [...new Set([...openIds, ...approved])];
}

export function registerCatalogTools(server) {
    registerTool(server, {
        name: 'list_models',
        description: 'All video + image models with gating status, resolutions, and whether YOU can use each one right now.',
        run: async ({ user }) => {
            const allowed = await allowedIdsFor(user.userId);
            const shape = (m, category) => ({
                id: m.id, name: m.name, category, gated: !!m.gated,
                resolutions: m.resolutions ?? null, allowed: allowed.includes(m.id),
            });
            return {
                models: [...MODELS.map((m) => shape(m, 'video')), ...IMAGE_MODELS.map((m) => shape(m, 'image'))],
                hint: 'For gated models you cannot use, call request_model_access.',
            };
        },
    });

    registerTool(server, {
        name: 'get_my_access',
        description: 'Your allowed models, pending/decided access requests, and this month’s spend.',
        run: async ({ user }) => ({
            allowedModelIds: await allowedIdsFor(user.userId),
            requests: await getRequestsForUser(user.userId),
            role: user.role ?? 'member',
            monthSpendUsd: await getMonthSpendUsd(user.userId),
        }),
    });

    registerTool(server, {
        name: 'request_model_access',
        description: 'Request access to a gated model for a project. An admin approves via Slack or the console.',
        schema: {
            modelId: z.string().min(1).max(100),
            projectId: z.number().int().positive(),
            note: z.string().max(500).optional(),
        },
        run: async ({ user, args }) => {
            if (!GATED_MODEL_IDS.includes(args.modelId) && !IMAGE_GATED_MODEL_IDS.includes(args.modelId)) {
                throw new ToolError('BAD_REQUEST', 'That model does not require a request.');
            }
            if (!user.email) throw new ToolError('BAD_REQUEST', 'No email on your account.');
            const sql = await getDb();
            if (!sql) throw new ToolError('DB_UNAVAILABLE', 'Access store unavailable.');
            const [member] = await sql`SELECT p.name FROM project_memberships m
                JOIN projects p ON p.id = m.project_id
                WHERE m.project_id = ${args.projectId} AND m.user_id = ${user.userId} LIMIT 1`;
            if (!member) throw new ToolError('NOT_A_PROJECT_MEMBER', 'You are not a member of that project.');
            const { id, status } = await requestAccess(user.userId, user.email, args.modelId, args.note ?? null, args.projectId);
            if (status === 'pending') {
                await notifySlackAccessRequested({ id, email: user.email, modelId: args.modelId, projectName: member.name, note: args.note ?? null }).catch(() => {});
            }
            return { ok: true, status };
        },
    });
}
```
(Mirrors `app/api/access/me/route.js:8-21` and `app/api/access/request/route.js` exactly — same membership check, same Slack ping on fresh pending only. Verify `IMAGE_GATED_MODEL_IDS` is exported from `lib/seedance/constants.js` — the request route imports it; if the export name differs, match the route's import.)

- [ ] **Step 2: Register in the route** — in `app/api/mcp/[transport]/route.js` add `import { registerCatalogTools } from '../../../../lib/mcp/tools/catalog.js';` and call `registerCatalogTools(server);` inside the `createMcpHandler` callback.

- [ ] **Step 3: Verify** — `npm run build` passes; `node --test tests/*.test.mjs` passes. Dev-server smoke: the 401 curl from Task 1 still returns 401 (auth intact).

- [ ] **Step 4: Commit** — `git commit -m "feat: MCP catalog tools — list_models, get_my_access, request_model_access"`

---

### Task 5: Project tools

**Files:**
- Create: `lib/mcp/tools/projects.js`
- Modify: `app/api/mcp/[transport]/route.js` (register)

**Interfaces:**
- Consumes: `registerTool`, `toolGatewayCtx`, `ToolError`; `writeAudit` from `lib/gateway/db.js`.
- Produces: `registerProjectTools(server)`. `list_projects` returns `{ items: [{ id, name, paused, my_role, member_count, spent_usd }], canManageProjects }` — generation tools tell users to pick a `projectId` from here.

- [ ] **Step 1: Implement**

```js
// lib/mcp/tools/projects.js — list_projects, create_project, update_project.
import { z } from 'zod';
import { registerTool, toolGatewayCtx, ToolError } from '../register.js';
import { writeAudit } from '../../gateway/db.js';

export function registerProjectTools(server) {
    registerTool(server, {
        name: 'list_projects',
        description: 'Projects you can act on, with member count and spend. Admins/managers see every project.',
        run: async ({ user }) => {
            const { sql, isPlatformAdmin, isOrgManager } = await toolGatewayCtx(user, {});
            const canManageProjects = isPlatformAdmin || isOrgManager;
            const rows = canManageProjects
                ? await sql`SELECT p.*, m2.role AS my_role,
                      (SELECT count(*)::int FROM project_memberships m WHERE m.project_id = p.id) AS member_count,
                      (SELECT COALESCE(SUM(COALESCE(b.cost_usd, b.est_cost_usd, 0)), 0)::float8 FROM billing_events b
                        WHERE b.project_id = p.id AND b.event_type IN ('settlement', 'failure')) AS spent_usd
                   FROM projects p LEFT JOIN project_memberships m2 ON m2.project_id = p.id AND m2.user_id = ${user.userId}
                   WHERE p.archived_at IS NULL ORDER BY p.created_at`
                : await sql`SELECT p.*, m2.role AS my_role,
                      (SELECT count(*)::int FROM project_memberships m WHERE m.project_id = p.id) AS member_count,
                      (SELECT COALESCE(SUM(COALESCE(b.cost_usd, b.est_cost_usd, 0)), 0)::float8 FROM billing_events b
                        WHERE b.project_id = p.id AND b.event_type IN ('settlement', 'failure')) AS spent_usd
                   FROM projects p JOIN project_memberships m2 ON m2.project_id = p.id AND m2.user_id = ${user.userId}
                   WHERE p.archived_at IS NULL ORDER BY p.created_at`;
            return { items: rows, canManageProjects };
        },
    });

    registerTool(server, {
        name: 'create_project',
        description: 'Create a project (admins/managers only). You become a member automatically.',
        schema: { name: z.string().min(1).max(200) },
        run: async ({ user, args }) => {
            const { sql, isPlatformAdmin, isOrgManager } = await toolGatewayCtx(user, {});
            if (!isPlatformAdmin && !isOrgManager) throw new ToolError('FORBIDDEN', 'Only admins or managers can create projects.');
            const [project] = await sql`INSERT INTO projects (name, created_by)
                VALUES (${args.name.trim()}, ${user.userId})
                ON CONFLICT (name) DO UPDATE SET archived_at = NULL RETURNING *`;
            await sql`INSERT INTO project_memberships (project_id, user_id, role, added_by)
                VALUES (${project.id}, ${user.userId}, 'admin', ${user.userId}) ON CONFLICT DO NOTHING`;
            await writeAudit(sql, { actorId: user.userId, actorEmail: user.email, action: 'project.create', targetType: 'project', targetId: project.id, after: { name: args.name.trim() }, ip: 'mcp' });
            return project;
        },
    });

    registerTool(server, {
        name: 'update_project',
        description: 'Rename, pause/resume, or archive a project (admins/managers only).',
        schema: {
            projectId: z.number().int().positive(),
            name: z.string().min(1).max(200).optional(),
            paused: z.boolean().optional(),
            archived: z.boolean().optional(),
        },
        run: async ({ user, args }) => {
            const { sql, project, isPlatformAdmin, isOrgManager } = await toolGatewayCtx(user, { projectId: args.projectId });
            if (!isPlatformAdmin && !isOrgManager) throw new ToolError('FORBIDDEN', 'Only admins or managers can update projects.');
            const [updated] = await sql`UPDATE projects SET
                    name = COALESCE(${args.name?.trim() ?? null}, name),
                    paused = COALESCE(${args.paused ?? null}, paused),
                    archived_at = CASE WHEN ${args.archived ?? null}::boolean IS NULL THEN archived_at
                                       WHEN ${args.archived ?? false} THEN now() ELSE NULL END
                WHERE id = ${project.id} RETURNING *`;
            await writeAudit(sql, { actorId: user.userId, actorEmail: user.email, action: 'project.update', targetType: 'project', targetId: project.id, before: project, after: updated, ip: 'mcp' });
            return updated;
        },
    });
}
```
(`list_projects`/`create_project` SQL is copied verbatim from `app/api/projects/route.js:18-51`. Before finalizing `update_project`, compare with the console's PATCH in `app/api/projects/[id]/route.js` — if it exists, reuse its exact statements instead of the ones above.)

- [ ] **Step 2: Register** — add `registerProjectTools(server);` to the route.
- [ ] **Step 3: Verify** — `npm run build`; `node --test tests/*.test.mjs`.
- [ ] **Step 4: Commit** — `git commit -m "feat: MCP project tools — list/create/update with project.manage gating"`

---

### Task 6: History & gallery tools (+ galleryItem extraction)

**Files:**
- Create: `lib/seedance/galleryItem.mjs` (extracted from `app/api/gallery/route.js:25-58`)
- Modify: `app/api/gallery/route.js` (import the extracted functions, delete locals)
- Create: `lib/mcp/tools/history.js`
- Modify: `app/api/mcp/[transport]/route.js` (register)
- Test: `tests/galleryItem.test.mjs`

**Interfaces:**
- Consumes: `getJob`, `sweep`; `listCreators`, `listUserGenerations`, `listLikedGenerations`, `getTaskOwner` from `lib/access/db.js`; `hasPermission` from `lib/gateway/access.mjs`; `cancelJob` NOT here (Task 11).
- Produces: `galleryItem.mjs` exports `toItem(row)` and `presignKey(key)`; `registerHistoryTools(server)` with `list_generations`, `get_generation`, `browse_gallery`, `bin_generation`, `like_generation`.

- [ ] **Step 1: Write the failing test**

```js
// tests/galleryItem.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { toItem } from '../lib/seedance/galleryItem.mjs';

test('toItem maps a video row (no AK/SK in env → archiveUrl null) and an image row', () => {
    const video = toItem({ task_id: 't1', category: 'video', model_id: 'seedance-2.0-mini', status: 'succeeded', user_prompt: 'cat', liked: true, created_at: '2026-07-16' });
    assert.equal(video.mediaType, 'video');
    assert.equal(video.taskId, 't1');
    assert.equal(video.liked, true);
    const image = toItem({ task_id: 't2', category: 'image', image_prompt: 'dog', image_key: 'images/job-9-0.png' });
    assert.equal(image.mediaType, 'image');
    assert.equal(image.prompt, 'dog');
    assert.equal(image.archiveUrl, null);
});
```

- [ ] **Step 2: Run — FAIL.** Then extract: move `presignKey` (gallery route lines 25-31) and `toItem` (lines 36-58) plus the `BUCKET` const into `lib/seedance/galleryItem.mjs` **unchanged**, exporting both; it imports `presignGetUrl, encodePath, TOS_ENDPOINT` from `../byteplus/tosSign.js`, `archiveKeyForTask` from `./archiveKey.mjs`, `MODELS` from `./constants.js`. Update the gallery route to `import { toItem } from '../../../lib/seedance/galleryItem.mjs';` and delete the local copies.

- [ ] **Step 3: Run tests → PASS.** `npm run build` → gallery route compiles.

- [ ] **Step 4: Implement history tools**

```js
// lib/mcp/tools/history.js — list_generations, get_generation, browse_gallery,
// bin_generation, like_generation. Prompt privacy identical to the routes.
import { z } from 'zod';
import { registerTool, toolGatewayCtx, ToolError } from '../register.js';
import { getJob } from '../../gateway/db.js';
import { hasPermission } from '../../gateway/access.mjs';
import { listCreators, listUserGenerations, listLikedGenerations, getTaskOwner } from '../../access/db.js';
import { toItem, presignKey } from '../../seedance/galleryItem.mjs';
import { archiveKeyForTask } from '../../seedance/archiveKey.mjs';
import { getDb } from '../../db/neon.js';

async function canSeePrompts(sql, role) {
    const rolePerms = await sql`SELECT role_id, permission_id FROM role_permissions`;
    return hasPermission(role, 'prompt.view', rolePerms);
}

function redact(job, own, seePrompts) {
    if (own || seePrompts) return job;
    return { ...job, request_body: { category: job.request_body?.category ?? null } };
}

export function registerHistoryTools(server) {
    registerTool(server, {
        name: 'list_generations',
        description: 'Recent generations. scope "mine" (default) = yours; "project" = everyone’s in the project (needs usage.view).',
        schema: {
            projectId: z.number().int().positive().optional(),
            scope: z.enum(['mine', 'project']).optional(),
            category: z.enum(['video', 'image']).optional(),
        },
        run: async ({ user, args }) => {
            const scope = args.scope === 'project' ? 'project' : 'mine';
            const ctx = await toolGatewayCtx(user, args.projectId
                ? { projectId: args.projectId, permission: scope === 'project' ? 'usage.view' : 'generation.create' }
                : {});
            const { sql, role } = ctx;
            const category = args.category ?? null;
            const rows = args.projectId
                ? (scope === 'project'
                    ? await sql`SELECT * FROM jobs WHERE project_id = ${args.projectId}
                        AND (${category}::text IS NULL OR coalesce(request_body->>'category', 'video') = ${category})
                        ORDER BY created_at DESC LIMIT 100`
                    : await sql`SELECT * FROM jobs WHERE project_id = ${args.projectId} AND user_id = ${user.userId}
                        AND (${category}::text IS NULL OR coalesce(request_body->>'category', 'video') = ${category})
                        ORDER BY created_at DESC LIMIT 100`)
                : await sql`SELECT * FROM jobs WHERE user_id = ${user.userId}
                    AND (${category}::text IS NULL OR coalesce(request_body->>'category', 'video') = ${category})
                    ORDER BY created_at DESC LIMIT 100`;
            const seePrompts = await canSeePrompts(sql, role);
            return { items: rows.map((j) => redact(j, j.user_id === user.userId, seePrompts)) };
        },
    });

    registerTool(server, {
        name: 'get_generation',
        description: 'One generation by gateway id: full job row plus a presigned archive URL for finished videos.',
        schema: { generationId: z.number().int().positive() },
        run: async ({ user, args }) => {
            const base = await toolGatewayCtx(user, {});
            const job = await getJob(base.sql, args.generationId);
            if (!job) throw new ToolError('NOT_FOUND', 'Generation not found.');
            let role = base.role;
            if (job.user_id !== user.userId) {
                role = (await toolGatewayCtx(user, { projectId: job.project_id, permission: 'usage.view' })).role;
            }
            const own = job.user_id === user.userId;
            const seePrompts = own ? true : await canSeePrompts(base.sql, role);
            const isVideo = (job.request_body?.category ?? 'video') === 'video';
            const archiveUrl = isVideo && job.provider_task_id ? presignKey(archiveKeyForTask(job.provider_task_id)) : null;
            return { ...redact(job, own, seePrompts), archiveUrl };
        },
    });

    registerTool(server, {
        name: 'browse_gallery',
        description: 'Community gallery. No args = creators list; userId = that creator’s items; liked=true = all liked items; mine=true = your full history.',
        schema: {
            userId: z.string().max(200).optional(),
            liked: z.boolean().optional(),
            mine: z.boolean().optional(),
        },
        run: async ({ user, args }) => {
            if (args.mine) return { items: (await listUserGenerations(user.userId)).map(toItem) };
            if (args.liked) {
                return { items: (await listLikedGenerations()).map((r) => ({
                    ...toItem(r),
                    creator: r.user_id ? { id: r.user_id, name: r.creator_name, email: r.creator_email } : null,
                })) };
            }
            if (args.userId) return { items: (await listUserGenerations(args.userId)).map(toItem) };
            return { me: user.userId, creators: await listCreators() };
        },
    });

    const taskWriteTool = (name, column, description) => registerTool(server, {
        name,
        description,
        schema: { taskId: z.string().min(1).max(200), value: z.boolean() },
        run: async ({ user, args }) => {
            const owner = await getTaskOwner(args.taskId).catch(() => null);
            if (column === 'deleted' && owner && owner !== user.userId && user.role !== 'admin') {
                throw new ToolError('FORBIDDEN', 'Only the creator can remove this generation.');
            }
            const sql = await getDb();
            if (!sql) throw new ToolError('DB_UNAVAILABLE', 'Store unavailable.');
            // Copy the exact upsert statement from app/api/seedance/bin/route.js
            // (deleted) / app/api/seedance/likes/route.js (liked) — same statement,
            // ${args.value} in place of the request-body boolean.
            await sql`INSERT INTO seedance_prompts (task_id, user_id, ${sql(column)})
                VALUES (${args.taskId}, ${user.userId}, ${args.value})
                ON CONFLICT (task_id) DO UPDATE SET ${sql(column)} = ${args.value}`;
            return { ok: true, taskId: args.taskId, [column]: args.value };
        },
    });
    taskWriteTool('bin_generation', 'deleted', 'Soft-delete (value=true) or restore (value=false) one of YOUR generations by ModelArk task id.');
    taskWriteTool('like_generation', 'liked', 'Like (value=true) or unlike (value=false) any generation by ModelArk task id.');
}
```
**Important:** the upsert inside `taskWriteTool` is a stand-in — during implementation open `app/api/seedance/bin/route.js` and `app/api/seedance/likes/route.js`, copy their exact INSERT/UPDATE statements (they are the source of truth for `seedance_prompts` columns/conflict keys), and use one small helper per column instead of dynamic `${sql(column)}` if the neon client doesn't support identifier interpolation (it does not — write two explicit statements).

- [ ] **Step 5: Register** — `registerHistoryTools(server);` in the route.
- [ ] **Step 6: Verify** — `node --test tests/*.test.mjs` PASS; `npm run build` PASS.
- [ ] **Step 7: Commit** — `git commit -m "feat: MCP history tools + gallery item extraction — list/get/browse/bin/like"`

---

### Task 7: Server-side asset library + list/delete asset tools

**Files:**
- Create: `lib/byteplus/assetsServer.js`
- Create: `lib/mcp/tools/assets.js` (first half)
- Modify: `app/api/mcp/[transport]/route.js` (register)

**Interfaces:**
- Consumes: `signAssetRequest({ action, bodyStr, ak, sk })` and `assetUrl(action)` from `lib/byteplus/assetSign.js`; `uploadGroupName(project)` from `lib/seedance/assetsClient.js` (pure export, safe to import server-side).
- Produces: `assetsServer.js` exports `callAsset(action, payload)`, `listGroups(groupType)`, `listAssets(groupId)`, `getAsset(id)`, `createAsset({ groupId, url, kind, name })`, `deleteAsset(id)`, `ensureUploadGroup(project)`, `pollAssetActive(id, opts)` — same shapes as `lib/seedance/assetsClient.js` returns (`{ id, status, name, previewUrl, groupId }` for assets). `registerAssetTools(server)` (extended in Task 8).

- [ ] **Step 1: Implement assetsServer.js**

Port from `lib/seedance/assetsClient.js` (lines 58-180), replacing its proxy-`fetch` `callAsset` with direct signed calls. Copy each ported function's body **verbatim** except the `callAsset` implementation; keep `DEFAULT_PROJECT = 'default'` and `KIND_TO_ASSET_TYPE` identical:

```js
// lib/byteplus/assetsServer.js — server-side twin of lib/seedance/assetsClient.js.
// ponytail: thin duplication of 5 wrappers; unify behind an injected transport
// if a third caller ever appears.
import { signAssetRequest, assetUrl } from './assetSign.js';
import { uploadGroupName } from '../seedance/assetsClient.js';

const DEFAULT_PROJECT = 'default';
const KIND_TO_ASSET_TYPE = { image: 'Image', video: 'Video', audio: 'Audio' };
const uploadGroupCache = new Map();

export async function callAsset(action, payload) {
    const ak = process.env.ARK_AK?.trim();
    const sk = process.env.ARK_SK?.trim();
    if (!ak || !sk) throw new Error('ARK_AK / ARK_SK are not configured on the server.');
    const bodyStr = JSON.stringify(payload ?? {});
    const headers = signAssetRequest({ action, bodyStr, ak, sk });
    const res = await fetch(assetUrl(action), { method: 'POST', headers, body: bodyStr });
    const data = await res.json().catch(() => null);
    const apiError = data?.ResponseMetadata?.Error;
    if (!res.ok || apiError) throw new Error(apiError?.Message || `Asset API ${action} failed (${res.status}).`);
    return data;
}
// …then port listGroups, listAssets, getAsset, createAsset, ensureUploadGroup,
// pollAssetActive from assetsClient.js verbatim (they only call callAsset),
// plus: export async function deleteAsset(id) {
//     await callAsset('DeleteAsset', { Id: id, ProjectName: DEFAULT_PROJECT });
// }
```
Check `signAssetRequest`'s return in `lib/byteplus/assetSign.js:33` — if it returns headers, use as above; if it returns `{ headers, url }` adjust accordingly. Compare with how `app/api/byteplus/assets/route.js` POST forwards a request and mirror it exactly.

- [ ] **Step 2: Implement list/delete tools**

```js
// lib/mcp/tools/assets.js — list_assets, delete_asset (+ Task 8 adds uploads).
import { z } from 'zod';
import { registerTool, toolGatewayCtx, ToolError } from '../register.js';
import { ensureUploadGroup, listAssets, getAsset, deleteAsset, createAsset, pollAssetActive } from '../../byteplus/assetsServer.js';

export function registerAssetTools(server) {
    registerTool(server, {
        name: 'list_assets',
        description: 'Reference assets in a project’s asset pool (images/videos usable as generation refs).',
        schema: { projectId: z.number().int().positive() },
        run: async ({ user, args }) => {
            const { project } = await toolGatewayCtx(user, { projectId: args.projectId, permission: 'generation.create' });
            const groupId = await ensureUploadGroup(project);
            return { groupId, items: await listAssets(groupId, 'AIGC') };
        },
    });

    registerTool(server, {
        name: 'delete_asset',
        description: 'Delete an asset from a project’s pool. Only assets inside that project’s studio group.',
        schema: { projectId: z.number().int().positive(), assetId: z.string().min(1).max(64) },
        run: async ({ user, args }) => {
            const { project } = await toolGatewayCtx(user, { projectId: args.projectId, permission: 'generation.create' });
            const groupId = await ensureUploadGroup(project);
            const asset = await getAsset(args.assetId);
            if (String(asset.groupId) !== String(groupId)) {
                throw new ToolError('FORBIDDEN', 'That asset is not in this project’s pool.');
            }
            await deleteAsset(args.assetId);
            return { ok: true, deleted: args.assetId };
        },
    });
}
```

- [ ] **Step 3: Register + verify** — `registerAssetTools(server);`; `npm run build`; existing tests pass (`tests/resolveVideoRefs.test.mjs` still green — assetsClient untouched).
- [ ] **Step 4: Commit** — `git commit -m "feat: server-side asset library + MCP list/delete asset tools"`

---

### Task 8: Upload tools — create_upload_url, register_asset

**Files:**
- Create: `lib/byteplus/uploadUrl.js` (extracted from `app/api/byteplus/upload/route.js`)
- Modify: `app/api/byteplus/upload/route.js` (use the extraction)
- Modify: `lib/mcp/tools/assets.js` (add two tools)

**Interfaces:**
- Consumes: `presignPutUrl`, `presignGetUrl`, `encodePath`, `TOS_ENDPOINT` from `lib/byteplus/tosSign.js`; `createAsset`, `ensureUploadGroup`, `pollAssetActive` (Task 7).
- Produces: `presignUpload({ name, contentType }) → Promise<{ putUrl, getUrl, key, contentType } | { error }>` — moves `ensureBucket`/`ensureCors`/key-building out of the route so route + tool share it.

- [ ] **Step 1: Extract.** Move from `app/api/byteplus/upload/route.js` into `lib/byteplus/uploadUrl.js`: `credentials()`, `sanitizeName()`, `tosFetch()`, `ensureBucket()`, `ensureCors()`, the `BUCKET` const, and a new composition:

```js
export async function presignUpload({ name = 'file', contentType = 'application/octet-stream' }) {
    const creds = credentials();
    if (!creds) return { error: 'ARK_AK / ARK_SK are not configured — add them to .env.local and restart.' };
    const bucketProblem = (await ensureBucket(creds)) || (await ensureCors(creds));
    if (bucketProblem) return { error: bucketProblem };
    const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${sanitizeName(name)}`;
    const host = `${BUCKET}.${TOS_ENDPOINT}`;
    const path = `/${encodePath(key)}`;
    return {
        putUrl: presignPutUrl({ host, path, contentType, ak: creds.ak, sk: creds.sk }),
        getUrl: presignGetUrl({ host, path, ak: creds.ak, sk: creds.sk }),
        key, contentType,
    };
}
```
The route's GET becomes: parse query → `const r = await presignUpload({ name, contentType });` → 502/500 on `r.error` (same messages/status as before), else `NextResponse.json(r)`. Function bodies move verbatim.

- [ ] **Step 2: Add the two tools to `lib/mcp/tools/assets.js`** (inside `registerAssetTools`):

```js
    registerTool(server, {
        name: 'create_upload_url',
        description: 'Presigned PUT URL for uploading a LOCAL file (from Claude Code: `curl -X PUT --upload-file <file> -H "Content-Type: <type>" "<putUrl>"`). Then call register_asset with the returned getUrl.',
        schema: {
            projectId: z.number().int().positive(),
            name: z.string().min(1).max(200),
            contentType: z.string().min(1).max(100),
        },
        run: async ({ user, args }) => {
            await toolGatewayCtx(user, { projectId: args.projectId, permission: 'generation.create' });
            const r = await presignUpload({ name: args.name, contentType: args.contentType });
            if (r.error) throw new ToolError('UPLOAD_UNAVAILABLE', r.error);
            return { ...r, next: 'PUT your file to putUrl, then call register_asset with url=getUrl.' };
        },
    });

    registerTool(server, {
        name: 'register_asset',
        description: 'Register a publicly reachable image/video URL into the project’s asset pool. Waits for verification (~10-30s). The returned asset id works as a ref in create_video / create_image.',
        schema: {
            projectId: z.number().int().positive(),
            url: z.string().url().max(3000),
            kind: z.enum(['image', 'video']),
            name: z.string().max(64).optional(),
        },
        run: async ({ user, args }) => {
            const { project } = await toolGatewayCtx(user, { projectId: args.projectId, permission: 'generation.create' });
            const groupId = await ensureUploadGroup(project);
            const assetId = await createAsset({ groupId, url: args.url, kind: args.kind, name: args.name });
            const asset = await pollAssetActive(assetId, { intervalMs: 3000, maxAttempts: 60 });
            return { assetId, status: asset.status, name: asset.name, previewUrl: asset.previewUrl };
        },
    });
```
Add `import { presignUpload } from '../../byteplus/uploadUrl.js';` at the top.

- [ ] **Step 3: Verify** — `npm run build`; dev-server: `curl -s 'http://localhost:3000/api/byteplus/upload?name=t.jpg&type=image/jpeg' -H "Cookie: <a signed-in session>"` still returns `{ putUrl, getUrl, key }` (or run the studio upload once manually). Existing tests pass.
- [ ] **Step 4: Commit** — `git commit -m "feat: MCP upload tools — presigned PUT extraction, create_upload_url, register_asset"`

---

### Task 9: Extract the governed video create path

**Files:**
- Create: `lib/gateway/videoCreate.mjs`
- Modify: `app/api/byteplus/[[...path]]/route.js:26-280`

**Interfaces:**
- Produces: `createVideoTask({ user, projectId, mode, request }) → Promise<{ status, body }>` where `request` is the raw ModelArk create-task JSON (`{ model, content, resolution, duration, ratio }`), `projectId` replaces the `x-seedance-project` header, `mode` replaces `x-seedance-mode`. `body` on success is ModelArk's response (`body.id` = provider task id) plus `body.jobId` (gateway job id) when governed. Also exports `hasVideoInput(content)` (moved).

- [ ] **Step 1: Create `lib/gateway/videoCreate.mjs`.** Move from the byteplus route, changing ONLY the noted lines:
  - `hasVideoInput` (route lines 26-28) — move verbatim, export it.
  - `resolveGateway` (lines 50-94) — signature becomes `resolveGateway(sql-lookup inside, user, modelId, projectId)`; replace line 64 (`const headerId = Number(request.headers.get('x-seedance-project')) || null;`) with `const headerId = Number(projectId) || null;`. Errors: return `{ error: { status, body } }` plain objects instead of `NextResponse.json(...)` — e.g. `{ error: { status: 403, body: { code: 'NOT_A_PROJECT_MEMBER', error: '…same message…' } } }`. Everything else verbatim.
  - `releaseProxyJob` (lines 97-106) — verbatim.
  - The POST create-task body (lines 159-279) becomes the exported function; replace every `NextResponse.json(X, { status: S })` with `return { status: S, body: X }`, replace both `request.headers.get('x-seedance-mode')` reads with the `mode` param, and on the success path (line 259-272) add `jobId: job?.id ?? null` into the returned body:

```js
// lib/gateway/videoCreate.mjs — the governed ModelArk create-task pipeline,
// shared by the /api/byteplus proxy route and the MCP create_video tool.
export async function createVideoTask({ user, projectId = null, mode = null, request }) {
    const key = process.env.ARK_API_KEY;
    if (!key) return { status: 500, body: { error: 'ARK_API_KEY is not configured on the server.' } };
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    const targetUrl = `${ARK_BASE}/${CREATE_TASK_PATH}`;
    const body = JSON.stringify(request);
    const parsed = request;
    const modelId = parsed?.model;
    // …lines 166-279 of the route, with the substitutions above…
}
```

- [ ] **Step 2: Refactor the route.** `app/api/byteplus/[[...path]]/route.js` POST keeps: header/key check, path parsing, the non-create-task passthrough (lines 150-157), `getUser()`; then for the create-task path:

```js
    const result = await createVideoTask({
        user,
        projectId: Number(request.headers.get('x-seedance-project')) || null,
        mode: request.headers.get('x-seedance-mode') || null,
        request: parsed ?? {},
    });
    return NextResponse.json(result.body, { status: result.status });
```
Delete the moved functions from the route; import `createVideoTask` from `../../../../lib/gateway/videoCreate.mjs`. Keep GET untouched.

- [ ] **Step 3: Verify hard.** `npm run build` passes. `node --test tests/*.test.js tests/*.test.mjs` passes. Then a real dev-server smoke: from the studio UI, submit one cheap generation (seedance-2.0-mini, 480p, shortest duration) and confirm (a) task submits, (b) a `jobs` row appears with `provider_task_id`, (c) denial still works by requesting a gated model without a grant.
- [ ] **Step 4: Commit** — `git commit -m "refactor: extract governed video create into lib/gateway/videoCreate.mjs (route behavior unchanged)"`

---

### Task 10: Extract image enqueue + create_video / create_image tools

**Files:**
- Create: `lib/gateway/enqueue.mjs` (extracted from `app/api/generations/route.js:23-112`)
- Modify: `app/api/generations/route.js` (POST becomes a thin wrapper)
- Create: `lib/mcp/videoContent.mjs`
- Create: `lib/mcp/tools/generate.js` (first half)
- Test: `tests/videoContent.test.mjs`

**Interfaces:**
- Consumes: `createVideoTask` (Task 9), `getAsset` (Task 7), schemas (Task 3).
- Produces: `enqueueGeneration({ user, projectId, modelId, request, options, priority }) → Promise<{ status, body }>` (202 body: `{ generationId, status: 'queued', estCostUsd }`); `buildVideoContent({ prompt, refs }) → content[]` (pure); `registerGenerateTools(server)` with `create_video`, `create_image` (Task 11 adds status/cancel).

- [ ] **Step 1: Failing test for the pure content builder**

```js
// tests/videoContent.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVideoContent } from '../lib/mcp/videoContent.mjs';

test('prompt only → single text item', () => {
    assert.deepEqual(buildVideoContent({ prompt: 'a cat' }), [{ type: 'text', text: 'a cat' }]);
});

test('image ref → image_url item with role; video ref → video_url item', () => {
    const content = buildVideoContent({
        prompt: 'p',
        refs: [
            { url: 'https://x/a.png', role: 'first_frame' },
            { url: 'https://x/b.mp4', role: 'reference_video' },
        ],
    });
    assert.deepEqual(content[1], { type: 'image_url', role: 'first_frame', image_url: { url: 'https://x/a.png' } });
    assert.deepEqual(content[2], { type: 'video_url', role: 'reference_video', video_url: { url: 'https://x/b.mp4' } });
});
```

- [ ] **Step 2: Run — FAIL. Then implement videoContent.mjs**

```js
// lib/mcp/videoContent.mjs — pure: prompt + resolved ref URLs → ModelArk content.
const VIDEO_ROLES = new Set(['reference_video']);

export function buildVideoContent({ prompt, refs = [] }) {
    const items = refs.map((r) => VIDEO_ROLES.has(r.role)
        ? { type: 'video_url', role: r.role, video_url: { url: r.url } }
        : { type: 'image_url', role: r.role, image_url: { url: r.url } });
    return [{ type: 'text', text: prompt }, ...items];
}
```
**Grounding step:** before finalizing, `grep -n "video_url\|image_url\|first_frame" app/seedance/SeedanceStudio.jsx app/seedance/PromptBar.jsx` and make the item shape match what the studio actually sends to `/api/byteplus/contents/generations/tasks` (roles and nesting must be identical — `tests/modeGating.test.mjs` documents that BytePlus infers task type from content roles). Adjust builder + test together if the studio's shape differs.

- [ ] **Step 3: Extract `enqueueGeneration`.** Move `accessRows`, `estimateFor`, and the POST body of `app/api/generations/route.js` (lines 39-112) into `lib/gateway/enqueue.mjs` as:

```js
export async function enqueueGeneration({ user, projectId, modelId, request, options = null, priority = 'interactive' }) {
    // body of the route's POST from the gatewayContext call onward, with:
    //  - gatewayContext({...}) → gatewayContextFor(user, { projectId, permission: 'generation.create' })
    //  - apiError(...) returns → { status: <same>, body: { code, message, ...detail } }
    //    (use the same codes/messages; STATUS map values from lib/gateway/httpError.mjs)
    //  - final success → { status: 202, body: { generationId: job.id, status: 'queued', estCostUsd: estimate.usd } }
    //  - keep after(() => processQueue()) OUT of the lib (see below).
}
```
The lib returns `{ status, body, enqueued: boolean }`; both callers fire the queue kick themselves: the route keeps `after(() => processQueue().catch(() => {}))`, the MCP tool calls `processQueue().catch(() => {})` directly (no `after` outside route handlers... `after` from `next/server` works in any server context in Next 15 — if the import works in the tool path, prefer `after`; otherwise fire-and-forget). All statements otherwise verbatim; the route POST shrinks to parse-body → validate presence → `enqueueGeneration(...)` → `NextResponse.json(r.body, { status: r.status })`.

- [ ] **Step 4: Implement the two create tools**

```js
// lib/mcp/tools/generate.js — create_video, create_image (+ status/cancel in Task 11).
import { z } from 'zod';
import { registerTool, toolGatewayCtx, ToolError } from '../register.js';
import { createVideoShape, createImageShape } from '../schemas.mjs';
import { buildVideoContent } from '../videoContent.mjs';
import { createVideoTask } from '../../gateway/videoCreate.mjs';
import { enqueueGeneration } from '../../gateway/enqueue.mjs';
import { getAsset } from '../../byteplus/assetsServer.js';

// assetId refs → { url, role } via the asset library's preview URL.
async function resolveRefs(refs = []) {
    return Promise.all(refs.map(async (r) => {
        if (r.url) return { url: r.url, role: r.role };
        if (!r.assetId) throw new ToolError('BAD_REQUEST', 'Each ref needs an assetId or a url.');
        const asset = await getAsset(r.assetId);
        if (asset.status !== 'Active' || !asset.previewUrl) throw new ToolError('BAD_REQUEST', `Asset ${r.assetId} is not ready (status ${asset.status}).`);
        return { url: asset.previewUrl, role: r.role };
    }));
}

// Reference images for the image models must be inlined base64 (the studio
// downscales client-side; here we fetch server-side). Caps mirror
// lib/gateway/validateImageRequest.mjs: ≤3 refs, ~4MB base64 total.
async function fetchRefsAsParts(refs = []) {
    const resolved = await resolveRefs(refs);
    const parts = [];
    let total = 0;
    for (const r of resolved) {
        const res = await fetch(r.url);
        if (!res.ok) throw new ToolError('BAD_REQUEST', `Could not fetch ref ${r.url} (${res.status}).`);
        const mime = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
        if (!mime.startsWith('image/')) throw new ToolError('BAD_REQUEST', 'Image refs must be images.');
        const b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
        total += b64.length;
        if (total > 4 * 1024 * 1024) throw new ToolError('BAD_REQUEST', 'Reference images exceed the 4MB total cap — use smaller images.');
        parts.push({ inlineData: { mimeType: mime, data: b64 } });
    }
    return parts;
}

export function registerGenerateTools(server) {
    registerTool(server, {
        name: 'create_video',
        description: 'Generate a video (Seedance family). Returns taskId + jobId — poll with get_job_status. Costs real money; quotas and model grants apply.',
        schema: createVideoShape,
        run: async ({ user, args }) => {
            const refs = await resolveRefs(args.refs);
            const request = {
                model: args.model,
                content: buildVideoContent({ prompt: args.prompt, refs }),
                ...(args.resolution ? { resolution: args.resolution } : {}),
                ...(args.duration ? { duration: args.duration } : {}),
                ...(args.ratio ? { ratio: args.ratio } : {}),
            };
            const result = await createVideoTask({ user, projectId: args.projectId ?? null, mode: args.mode ?? null, request });
            if (result.status >= 400) throw new ToolError(result.body?.code ?? 'CREATE_FAILED', result.body?.error ?? result.body?.message ?? 'Video create failed.');
            return { taskId: result.body.id, jobId: result.body.jobId ?? null, poll: 'get_job_status with this taskId' };
        },
    });

    registerTool(server, {
        name: 'create_image',
        description: 'Generate image(s) (Nano Banana 2/Pro, Seedream 5.0 Pro). Returns generationId — poll with get_job_status. Quotas and model grants apply.',
        schema: createImageShape,
        run: async ({ user, args }) => {
            const parts = args.refs?.length ? await fetchRefsAsParts(args.refs) : null;
            const result = await enqueueGeneration({
                user,
                projectId: args.projectId,
                modelId: args.model,
                request: { prompt: args.prompt, ...(parts ? { parts } : {}) },
                options: {
                    ...(args.imageCount ? { imageCount: args.imageCount } : {}),
                    ...(args.aspectRatio ? { aspectRatio: args.aspectRatio } : {}),
                    ...(args.imageSize ? { imageSize: args.imageSize } : {}),
                },
            });
            if (result.status >= 400) throw new ToolError(result.body?.code ?? 'CREATE_FAILED', result.body?.message ?? 'Image create failed.');
            return result.body; // { generationId, status: 'queued', estCostUsd }
        },
    });
}
```
**Grounding step for parts:** confirm the sanitized parts shape against `lib/gateway/validateImageRequest.mjs:20+` (`sanitizeImageRequest` — it expects `request.parts`; check whether each part is `{ inlineData: { mimeType, data } }` or `{ mimeType, data }` and match it exactly, adjusting `fetchRefsAsParts`).

- [ ] **Step 5: Register + run everything** — `registerGenerateTools(server);`; `node --test tests/*.test.js tests/*.test.mjs` PASS; `npm run build` PASS; studio smoke: one image generation from the UI still enqueues (route now goes through `enqueueGeneration`).
- [ ] **Step 6: Commit** — `git commit -m "feat: MCP generation tools — create_video/create_image over extracted governed paths"`

---

### Task 11: get_job_status + cancel_job

**Files:**
- Modify: `lib/mcp/tools/generate.js`

**Interfaces:**
- Consumes: `getJob` from `lib/gateway/db.js`; `cancelJob(sql, job, { reason })` from `lib/gateway/cancel.mjs`; `sweep` from `lib/gateway/sweep.mjs`; `presignKey` + `archiveKeyForTask` (Task 6 exports).
- Produces: `get_job_status({ generationId? , taskId? })`, `cancel_job({ generationId })` registered inside `registerGenerateTools`.

- [ ] **Step 1: Add to `registerGenerateTools`**

```js
    registerTool(server, {
        name: 'get_job_status',
        description: 'Status of a generation. Pass generationId (gateway id from create_image / jobId from create_video) OR taskId (ModelArk id from create_video). Finished videos include a playable URL.',
        schema: {
            generationId: z.number().int().positive().optional(),
            taskId: z.string().min(1).max(200).optional(),
        },
        run: async ({ user, args }) => {
            if (args.generationId) {
                const { sql, role } = await toolGatewayCtx(user, {});
                sweep().catch(() => {}); // status polls drive queue maintenance (no cron on Hobby)
                const job = await getJob(sql, args.generationId);
                if (!job) throw new ToolError('NOT_FOUND', 'Generation not found.');
                if (job.user_id !== user.userId) await toolGatewayCtx(user, { projectId: job.project_id, permission: 'usage.view' });
                const isVideo = (job.request_body?.category ?? 'video') === 'video';
                return {
                    generationId: job.id, status: job.status, error: job.error ?? null,
                    result: job.result ?? null, providerTaskId: job.provider_task_id ?? null,
                    videoUrl: isVideo && job.provider_task_id ? presignKey(archiveKeyForTask(job.provider_task_id)) : null,
                };
            }
            if (!args.taskId) throw new ToolError('BAD_REQUEST', 'Pass generationId or taskId.');
            const key = process.env.ARK_API_KEY;
            if (!key) throw new ToolError('CONFIG', 'ARK_API_KEY is not configured.');
            const res = await fetch(`https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks/${encodeURIComponent(args.taskId)}`, {
                headers: { Authorization: `Bearer ${key}` },
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new ToolError('PROVIDER_ERROR', data?.error?.message ?? `Provider returned ${res.status}.`);
            return {
                taskId: args.taskId, status: data?.status ?? 'unknown',
                videoUrl: data?.content?.video_url ?? presignKey(archiveKeyForTask(args.taskId)),
                raw: data,
            };
        },
    });

    registerTool(server, {
        name: 'cancel_job',
        description: 'Cancel a queued/running generation by gateway generationId. Creators cancel their own; managers/admins can cancel any in their reach.',
        schema: { generationId: z.number().int().positive() },
        run: async ({ user, args }) => {
            const { sql, role } = await toolGatewayCtx(user, {});
            const job = await getJob(sql, args.generationId);
            if (!job) throw new ToolError('NOT_FOUND', 'Generation not found.');
            const own = job.user_id === user.userId;
            if (!own) {
                const scoped = await toolGatewayCtx(user, { projectId: job.project_id, permission: 'usage.view' });
                if (scoped.role !== 'admin' && scoped.role !== 'manager') {
                    throw new ToolError('FORBIDDEN', 'Only the creator or a manager can cancel this generation.');
                }
            }
            const cancelled = await cancelJob(sql, job, { reason: own ? 'cancelled by creator (MCP)' : 'cancelled by admin (MCP)' });
            if (!cancelled) throw new ToolError('BAD_REQUEST', 'Generation already finished.');
            return { ok: true, status: 'cancelled' };
        },
    });
```
Add imports: `getJob` from `../../gateway/db.js`, `cancelJob` from `../../gateway/cancel.mjs`, `sweep` from `../../gateway/sweep.mjs`, `presignKey` from `../../seedance/galleryItem.mjs`, `archiveKeyForTask` from `../../seedance/archiveKey.mjs`. **Grounding step:** check the ModelArk task response shape used by the studio poller (`grep -n "content\|video_url" app/seedance/SeedanceStudio.jsx | head`) and align the `videoUrl` extraction.

- [ ] **Step 2: Verify + commit** — build + tests pass. `git commit -m "feat: MCP job status + cancel tools"`

---

### Task 12: Usage + admin tools

**Files:**
- Create: `lib/mcp/tools/admin.js`
- Modify: `app/api/mcp/[transport]/route.js` (register)

**Interfaces:**
- Consumes: `usageRollup(sql, { projectId, groupBy, from, to })` from `lib/gateway/usageQuery.js`; `listRequests`, `setRequestStatus`, `listActiveGrants` from `lib/access/db.js`; `nextStatus` from `lib/access/requestStatus.mjs`; `syncGatewayOverride` from `lib/access/gatewaySync.mjs`; `usageForQuotas` from `lib/gateway/db.js`; `writeAudit`.
- Produces: `registerAdminTools(server)` — 6 tools. Admin denial = the gateway's own permission message.

- [ ] **Step 1: Implement**

```js
// lib/mcp/tools/admin.js — get_usage, access-request admin, quotas, audit.
import { z } from 'zod';
import { registerTool, toolGatewayCtx, ToolError } from '../register.js';
import { usageRollup } from '../../gateway/usageQuery.js';
import { usageForQuotas, writeAudit } from '../../gateway/db.js';
import { listRequests, setRequestStatus } from '../../access/db.js';
import { nextStatus } from '../../access/requestStatus.mjs';
import { syncGatewayOverride } from '../../access/gatewaySync.mjs';

const QUOTA_TYPES = ['usd', 'credits', 'image_count', 'video_seconds', 'request_count'];
const QUOTA_WINDOWS = ['daily', 'monthly', 'lifetime'];

export function registerAdminTools(server) {
    registerTool(server, {
        name: 'get_usage',
        description: 'Spend rollup. With projectId: that project (needs usage.view there). Without: workspace-wide (admin/manager only).',
        schema: {
            projectId: z.number().int().positive().optional(),
            groupBy: z.enum(['model', 'user', 'project', 'day']).optional(),
            from: z.string().max(30).optional(),
            to: z.string().max(30).optional(),
        },
        run: async ({ user, args }) => {
            const ctx = await toolGatewayCtx(user, args.projectId ? { projectId: args.projectId, permission: 'usage.view' } : {});
            if (!args.projectId && !ctx.isPlatformAdmin && !ctx.isOrgManager) {
                throw new ToolError('FORBIDDEN', 'Workspace-wide usage needs an admin or manager role — pass a projectId.');
            }
            const rows = await usageRollup(ctx.sql, {
                projectId: args.projectId ?? null, groupBy: args.groupBy ?? 'model',
                from: args.from ?? null, to: args.to ?? null,
            });
            return { rows };
        },
    });

    registerTool(server, {
        name: 'list_access_requests',
        description: 'Pending + decided model access requests (admin).',
        run: async ({ user }) => {
            await toolGatewayCtx(user, { permission: 'model.grant' });
            return { requests: await listRequests() };
        },
    });

    registerTool(server, {
        name: 'resolve_access_request',
        description: 'Approve or deny a model access request (admin). Approval grants until validUntilDays from now (default 2, like Slack).',
        schema: {
            requestId: z.number().int().positive(),
            action: z.enum(['approve', 'deny']),
            validUntilDays: z.number().int().min(1).max(365).optional(),
        },
        run: async ({ user, args }) => {
            await toolGatewayCtx(user, { permission: 'model.grant' });
            const approve = args.action === 'approve';
            const validUntil = approve
                ? new Date(Date.now() + (args.validUntilDays ?? Number(process.env.SLACK_APPROVE_DAYS) ?? 2) * 86400000).toISOString()
                : null;
            const byUser = `${user.email} (MCP)`;
            const row = await setRequestStatus(args.requestId, nextStatus(approve ? 'approve' : 'revoke'), byUser, validUntil);
            if (!row) throw new ToolError('NOT_FOUND', 'Request not found — it may already have been handled.');
            try {
                await syncGatewayOverride({ action: approve ? 'approve' : 'revoke', row, validUntil, admin: { userId: user.userId, email: user.email } });
            } catch (error) {
                console.error('[mcp] gateway sync failed:', error.message); // status already saved — same as Slack path
            }
            return { ok: true, requestId: args.requestId, status: row.status, expiresAt: row.expires_at ?? validUntil };
        },
    });

    registerTool(server, {
        name: 'list_quotas',
        description: 'Active budgets/quotas with usage (admin).',
        run: async ({ user }) => {
            const { sql } = await toolGatewayCtx(user, { permission: 'quota.manage' });
            const items = await sql`SELECT q.*, p.name AS project_name FROM quotas q
                LEFT JOIN projects p ON p.id = q.project_id
                WHERE q.deleted_at IS NULL ORDER BY q.created_at DESC`;
            const { usedByQuota, reservedByQuota } = await usageForQuotas(sql, items);
            return { items: items.map((q) => ({ ...q, used: usedByQuota[q.id] ?? 0, reserved: reservedByQuota[q.id] ?? 0 })) };
        },
    });

    registerTool(server, {
        name: 'set_quota',
        description: 'Create a budget/quota (admin). Scope: workspace (no ids), a project (projectId), or a user in a project (both).',
        schema: {
            type: z.enum(QUOTA_TYPES),
            window: z.enum(QUOTA_WINDOWS),
            hardLimit: z.number().positive(),
            projectId: z.number().int().positive().optional(),
            userId: z.string().max(200).optional(),
            policy: z.enum(['hard', 'soft']).optional(),
        },
        run: async ({ user, args }) => {
            const { sql } = await toolGatewayCtx(user, { permission: 'quota.manage' });
            const [quota] = await sql`INSERT INTO quotas
                (project_id, user_id, type, "window", hard_limit, policy, soft_overage_pct, alert_thresholds, created_by)
                VALUES (${args.projectId ?? null}, ${args.userId ?? null}, ${args.type}, ${args.window}, ${args.hardLimit},
                        ${args.policy === 'soft' ? 'soft' : 'hard'}, 5, ${[80, 90, 100]}, ${user.userId})
                RETURNING *`;
            await writeAudit(sql, { actorId: user.userId, actorEmail: user.email, action: 'quota.create', targetType: 'quota', targetId: quota.id, after: quota, ip: 'mcp' });
            return quota;
        },
    });

    registerTool(server, {
        name: 'view_audit',
        description: 'Audit trail, newest first (admin). Filters: actor (id/email), action prefix, target type, from/to ISO dates.',
        schema: {
            actor: z.string().max(200).optional(),
            action: z.string().max(100).optional(),
            target: z.string().max(50).optional(),
            from: z.string().max(30).optional(),
            to: z.string().max(30).optional(),
        },
        run: async ({ user, args }) => {
            const { sql } = await toolGatewayCtx(user, { permission: 'audit.view' });
            const rows = await sql.query(
                `SELECT * FROM audit_log
                 WHERE ($1::text IS NULL OR actor_id = $1 OR actor_email ILIKE '%' || $1 || '%')
                   AND ($2::text IS NULL OR action ILIKE $2 || '%')
                   AND ($3::text IS NULL OR target_type = $3)
                   AND ($4::timestamptz IS NULL OR created_at >= $4)
                   AND ($5::timestamptz IS NULL OR created_at < $5)
                 ORDER BY created_at DESC LIMIT 500`,
                [args.actor ?? null, args.action ?? null, args.target ?? null, args.from ?? null, args.to ?? null],
            );
            return { rows };
        },
    });
}
```
(`resolve_access_request` mirrors `app/api/webhooks/slack/route.js:100-137` — same `setRequestStatus` + `nextStatus` + `syncGatewayOverride` calls; `list_quotas`/`set_quota`/`view_audit` mirror `app/api/admin/quotas/route.js` and `app/api/admin/audit/route.js` verbatim minus CSV. Note `list_access_requests` uses `model.grant` where the console route used `isAdmin()` — equivalent, since only admins hold `model.grant`.)

- [ ] **Step 2: Register + verify** — `registerAdminTools(server);`; build + tests pass.
- [ ] **Step 3: Commit** — `git commit -m "feat: MCP usage + admin tools — usage rollup, access requests, quotas, audit"`

---

### Task 13: Docs, Clerk DCR, deploy, end-to-end verification

**Files:**
- Create: `docs/mcp.md`
- Modify: `docs/superpowers/specs/2026-07-16-mcp-server-design.md` (status → Implemented)

**Interfaces:** none — operational.

- [ ] **Step 1: Write `docs/mcp.md`** covering: what the server is; connector URL `https://<prod-domain>/api/mcp/mcp`; claude.ai setup (Settings → Connectors → Add custom connector → paste URL → sign in with your studio account); Claude Code setup (`claude mcp add --transport http logline https://<prod-domain>/api/mcp/mcp`); the full tool table from the spec with permissions; the local-file upload recipe (create_upload_url → curl PUT → register_asset); revocation (Clerk dashboard → user → OAuth applications); troubleshooting (401 loop = DCR not enabled; TOOL_FAILED = check Vercel logs).

- [ ] **Step 2: Clerk dashboard (manual, one-time)** — Clerk Dashboard → Configure → OAuth applications: enable **Dynamic Client Registration**. Confirm the instance's OAuth authorization server metadata loads: `curl -s https://<clerk-frontend-api-domain>/.well-known/oauth-authorization-server | head -c 300`.

- [ ] **Step 3: Deploy** — merge/push per repo flow (`feat/clerk-model-access`), let Vercel build the preview/production deployment, confirm `curl -s https://<domain>/.well-known/oauth-protected-resource/mcp` returns metadata on the deployed URL.

- [ ] **Step 4: E2E checklist (record results in docs/mcp.md):**
  1. claude.ai: add connector → Clerk sign-in popup appears → approve → tools listed.
  2. `ping` returns your userId.
  3. `list_projects` shows only YOUR projects for a member account; all projects for an admin.
  4. `create_video` with a non-granted gated model → friendly `MODEL_ACCESS_DENIED` pointing at `request_model_access`.
  5. `create_video` with `seedance-2.0-mini` (cheap) → taskId; `get_job_status` polls to a playable URL; a `jobs` row + usage/billing events exist for the right user + project.
  6. `create_image` with `nano-banana-2` → generationId → `get_job_status` returns image result.
  7. Claude Code: `claude mcp add --transport http logline https://<domain>/api/mcp/mcp` → `create_upload_url` → `curl -T photo.jpg` → `register_asset` → use as `first_frame` ref in `create_video`.
  8. Member account calling `set_quota` → permission denial.
  9. Usage dashboard shows the MCP-generated rows.

- [ ] **Step 5: Final commit** — `git commit -m "docs: MCP connector setup + E2E verification results"`

---

## Self-Review Notes (run after writing — resolved inline)

- **Spec coverage:** all 24 spec tools have tasks (catalog 3, projects 3, generation 4, history 5, assets 4, usage/admin 6 = 25 incl. ping). Exclusions (keys, role mgmt, muapi, zip) have no tasks — intentional.
- **Grounding steps** exist where the repo is the source of truth (bin/likes SQL, ModelArk content shape, image parts shape, Clerk export names, projects PATCH) — each names the exact file to copy from and what to verify; none are "TBD".
- **Type consistency:** `run({ user, args })`, `toolGatewayCtx(user, opts)`, `{ status, body }` extraction returns, and `presignKey`/`toItem` names are used consistently across tasks.
