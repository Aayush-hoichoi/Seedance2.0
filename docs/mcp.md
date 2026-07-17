# LoglineAI Studio — MCP Server

## What this is

A remote MCP (Model Context Protocol) server exposing the LoglineAI studio's
generation capabilities to Claude clients — claude.ai custom connectors,
Claude Code, and Claude Desktop. It runs **inside this Next.js app** (no
separate service) at `/api/mcp/mcp`, using Streamable HTTP via `mcp-handler`.

Authentication is OAuth through **Clerk** (`@clerk/nextjs` +
`@clerk/mcp-tools`): the connecting client discovers the auth server from
`/.well-known/oauth-protected-resource/mcp`, registers itself with Clerk via
Dynamic Client Registration (DCR), and the user signs in on Clerk's normal
hosted sign-in page with their existing studio account.

Every tool call then runs **as that signed-in Clerk user** — the same
project memberships, model grants, quotas, and usage attribution as the web
studio. There is no separate MCP permission model: `lib/mcp/register.js`
resolves the OAuth token to a `userId`, loads the same user object
`gatewayContext` uses for the web app, and every tool enforces the identical
permission the equivalent studio action requires. Generations created over
MCP write the same `jobs` rows and billing/usage events as generations
created in the browser — indistinguishable in the usage dashboard.

## Connector URL

```
https://<your-production-domain>/api/mcp/mcp
```

Substitute your actual deployment domain — this is deployment-specific. The
Vercel project backing this app is **`seedance2-0`**; if you don't know your
domain, check `vercel ls` or the Vercel dashboard for that project.

OAuth protected-resource metadata (RFC 9728) lives at:

```
https://<your-production-domain>/.well-known/oauth-protected-resource/mcp
```

MCP clients fetch this automatically during connection — you shouldn't need
to hit it by hand except to verify a deployment (see "Deploy" below).

## Client setup

### claude.ai (custom connector)

1. Settings → Connectors → **Add custom connector**.
2. Paste the connector URL: `https://<your-production-domain>/api/mcp/mcp`.
3. A browser popup opens Clerk's sign-in page. Sign in with your studio
   account (the same one you use for the web app).
4. After approval, the tool list populates — you're connected as that Clerk
   user with their real permissions.

### Claude Code

```bash
claude mcp add --transport http logline https://<your-production-domain>/api/mcp/mcp
```

Claude Code drives the same OAuth/DCR flow (opening a browser for the Clerk
sign-in) the first time you use the connector. Token refresh is automatic
after that.

## Tool reference

25 tools registered across 6 modules under `lib/mcp/tools/`, plus a `ping`
health check registered directly in the route handler
(`app/api/mcp/[transport]/route.js`). "Permission" is the gateway permission
`toolGatewayCtx` checks (`lib/mcp/schemas.mjs`'s `TOOL_PERMISSIONS`); "any
signed-in user" means the tool itself does no extra role check beyond
resolving the Clerk user, though the data returned is still scoped to that
user (e.g. their own projects/generations).

### Health check

| Tool | Purpose | Permission / scope |
|---|---|---|
| `ping` | Connectivity check — returns `{ pong: true, userId }` for the connected user | any signed-in user |

### Catalog & access (`lib/mcp/tools/catalog.js`)

| Tool | Purpose | Permission / scope |
|---|---|---|
| `list_models` | Every video + image model with gating status, resolutions, and whether **you** can use each one right now | any signed-in user |
| `get_my_access` | Your allowed model ids, pending/decided access requests, current role, and this month's spend | any signed-in user |
| `request_model_access` | Request access to a gated model for a project (feeds the existing Slack approval flow); requires project membership | any signed-in user (must be a member of the target project) |

### Projects (`lib/mcp/tools/projects.js`)

| Tool | Purpose | Permission / scope |
|---|---|---|
| `list_projects` | Projects you can act on, with member count and spend. Admins/managers see every non-archived project; everyone else sees only projects they're a member of | any signed-in user (scope varies by role) |
| `create_project` | Create a project; you're added as an `admin` member automatically. Re-creating an archived project's name un-archives it (`ON CONFLICT ... SET archived_at = NULL`) — this is also the **restore** path | admin or manager |
| `update_project` | Rename, pause/resume, or archive a project. Gating is split per field to mirror the console exactly: rename/pause require `project.manage` (admin/owner only — managers don't hold this permission); archive allows admin **or** manager. `archived: false` is rejected outright — restore only via `create_project` with the same name. The `Default` project can't be archived | `project.manage` for rename/pause; admin or manager for archive |

### Generation (`lib/mcp/tools/generate.js`)

| Tool | Purpose | Permission / scope |
|---|---|---|
| `create_video` | Generate a video (Seedance family) through the extracted governed path (`lib/gateway/videoCreate.mjs`). Returns `{ taskId, jobId }` — poll with `get_job_status`. Reference media resolves via `assetId` or a direct `url` | `generation.create` + model grant + quota |
| `create_image` | Generate image(s) (Nano Banana 2 / Nano Banana Pro / Seedream 5.0 Pro / Cinematic Studio) through the governed enqueue path. Reference images are fetched server-side and inlined as base64 parts (≤3 refs, ~4MB total). Returns `{ generationId, status: 'queued', estCostUsd }` | `generation.create` + model grant + quota |
| `get_job_status` | Poll a generation. Pass `generationId` (gateway id, from `create_image` or the `jobId` from `create_video`) **or** `taskId` (ModelArk id, from `create_video`). Finished videos include a playable URL | own jobs, or project membership with `usage.view` for others' |
| `cancel_job` | Cancel a queued/running generation by `generationId`. Creators cancel their own; managers/admins can cancel any job in their reach | own jobs, or manager/admin |

**Gated-model denial:** if `model` in `create_video` / `create_image` is
gated and you don't hold an approved grant, the call fails with code
`MODEL_ACCESS_DENIED` and a friendly message pointing you at
`request_model_access` — the same denial the web studio's model picker
shows, not a raw HTTP error.

### History & gallery (`lib/mcp/tools/history.js`)

| Tool | Purpose | Permission / scope |
|---|---|---|
| `list_generations` | Recent generations. `scope: "mine"` (default) = only yours; `scope: "project"` = everyone's in that project (needs `usage.view`). Optional `category` filter (`video`/`image`) | own, or `usage.view` for project-wide |
| `get_generation` | One generation by gateway id: full job row plus a presigned archive URL for finished videos | own, or project membership with `usage.view` for others' |
| `browse_gallery` | Community gallery. No args → list of creators; `userId` → that creator's items; `liked: true` → all liked items; `mine: true` → your full history | any signed-in user |
| `bin_generation` | Soft-delete (`value: true`) or restore (`value: false`) one of your generations by ModelArk `taskId`. Only the creator (or an admin) may bin a generation; ownerless legacy tasks stay open to everyone | own generations, or admin |
| `like_generation` | Like/unlike any generation by `taskId` — a shared mark, no ownership check | any signed-in user |

Prompt text is redacted for non-owners unless they hold `prompt.view`
(`list_generations`/`get_generation` return only `{ category }` for the
`request_body` in that case) — identical privacy behavior to the studio's
history views.

### Assets (`lib/mcp/tools/assets.js`)

| Tool | Purpose | Permission / scope |
|---|---|---|
| `list_assets` | Browse a project's reference-asset pool (images/videos usable as generation refs) | `generation.create` |
| `delete_asset` | Delete an asset — rejects if the asset isn't inside the calling project's own asset group | `generation.create`, own project |
| `create_upload_url` | Presigned TOS PUT URL for uploading a **local** file, plus the `getUrl` to hand to `register_asset` afterward | `generation.create` |
| `register_asset` | Register a publicly reachable image/video URL into the project's asset pool. Polls up to ~210s for verification; the returned `assetId` works as a ref in `create_video`/`create_image` once `Active` | `generation.create` |

**Local file upload from Claude Code** (`create_upload_url` → `curl` → `register_asset`):

```bash
# 1. Ask the connected model to call create_upload_url with your project id,
#    a file name, and its content type. It returns { putUrl, getUrl, key }.

# 2. PUT the local file straight to the presigned URL:
curl -X PUT --upload-file ./photo.jpg \
  -H "Content-Type: image/jpeg" \
  "<putUrl from step 1>"

# 3. Call register_asset with projectId, url=<getUrl from step 1>, kind="image".
#    The response includes assetId once verification succeeds.
```

**Partial success on `register_asset`:** if BytePlus hasn't finished
verifying the asset within the tool's poll deadline, it does **not** error —
it returns `{ assetId, status: "Processing", note: "Still verifying — check
list_assets in ~30s..." }`. The `assetId` is already valid to use once the
asset flips to `Active`; call `list_assets` shortly after to confirm.

### Usage & admin (`lib/mcp/tools/admin.js`)

| Tool | Purpose | Permission / scope |
|---|---|---|
| `get_usage` | Spend rollup grouped by model/user/provider/project/day. With `projectId`: that project (needs `usage.view` there). Without: workspace-wide, admin/manager only | `usage.view` (or admin/manager for workspace-wide) |

Workspace-wide usage (no `projectId`) is available to **admins and managers**
over MCP per the approved design spec — this deliberately differs from the
console's `/api/orgs/usage` route, which restricts the same workspace-wide
rollup to admins only.
| `list_access_requests` | Pending + decided model access requests | `model.grant` |
| `resolve_access_request` | Approve or deny a model access request; approval grants access until `validUntilDays` from now (default 2, same as the Slack flow) and syncs the gateway override | `model.grant` |
| `list_quotas` | Active budgets/quotas with current usage/reserved amounts | `quota.manage` |
| `set_quota` | Create a budget/quota scoped to the workspace, a project, or a user within a project | `quota.manage` |
| `view_audit` | Audit trail, newest first, filterable by actor/action/target/date range | `audit.view` |

Admin tools are permission-gated per call via `toolGatewayCtx` — a member
account calling any of these gets a `FORBIDDEN`/permission-code denial, not
a hidden tool. (The tool still *appears* in the list; the gateway check
happens on invocation, matching how the console routes behave.)

## One-time Clerk setup (manual — do this before first connect)

MCP clients register themselves with Clerk dynamically (Dynamic Client
Registration / DCR) rather than using a pre-shared OAuth client id. This
must be turned on once per Clerk instance:

1. Clerk Dashboard → **Configure** → **OAuth applications**.
2. Enable **Dynamic Client Registration**.

**Verify it took effect** by fetching the instance's OAuth authorization
server metadata:

```bash
curl -s https://<clerk-frontend-api-domain>/.well-known/oauth-authorization-server | head -c 300
```

A JSON body describing the authorization/token endpoints (and, once DCR is
on, a `registration_endpoint`) confirms it's live. If DCR is not enabled,
clients that try to connect will loop back to sign-in without ever reaching
a tool list (see Troubleshooting).

## Deploy

Push to this repo's normal deploy branch (`feat/clerk-model-access` — see
the repo's push-target convention) and let Vercel build the
preview/production deployment for the `seedance2-0` project as usual. No
extra Vercel configuration is needed for the MCP route itself; it's a
regular Next.js route.

Once deployed, verify the OAuth protected-resource metadata is reachable on
the live domain:

```bash
curl -s https://<your-production-domain>/.well-known/oauth-protected-resource/mcp
```

This should return metadata (not a 404), and should return before you point
any MCP client at the connector URL.

## E2E verification (pending)

The checklist below is the manual end-to-end pass against a live deployment
(claude.ai + Claude Code, real Clerk sign-in, real generations). It has not
been run yet — results should be filled in as each step is executed against
the deployed URL.

| # | Check | Result |
|---|---|---|
| 1 | claude.ai: add connector → Clerk sign-in popup appears → approve → tools listed | |
| 2 | `ping` returns your userId | |
| 3 | `list_projects` shows only YOUR projects for a member account; all projects for an admin | |
| 4 | `create_video` with a non-granted gated model → friendly `MODEL_ACCESS_DENIED` pointing at `request_model_access` | |
| 5 | `create_video` with `seedance-2.0-mini` (cheap, non-gated) → taskId; `get_job_status` polls to a playable URL; a `jobs` row + usage/billing events exist for the right user + project | |
| 6 | `create_image` with `nano-banana-2` → generationId → `get_job_status` returns image result | |
| 7 | Claude Code: `claude mcp add --transport http logline https://<your-production-domain>/api/mcp/mcp` → `create_upload_url` → `curl -T photo.jpg` → `register_asset` → use as `first_frame` ref in `create_video` | |
| 8 | Member account calling `set_quota` → permission denial | |
| 9 | Usage dashboard shows the MCP-generated rows | |

## Troubleshooting

- **401 loop / sign-in never completes, no tool list appears** — Dynamic
  Client Registration is not enabled on the Clerk instance. Go back to
  "One-time Clerk setup" above and confirm the DCR toggle, then re-verify
  the `/.well-known/oauth-authorization-server` metadata includes a
  registration endpoint.
- **`TOOL_FAILED` error from any tool** — this is the catch-all
  (`lib/mcp/register.js`) for an unexpected exception inside a tool's `run`.
  Check the Vercel function logs for the deployment (Vercel dashboard →
  project `seedance2-0` → the deployment → Functions/Logs, or `vercel logs`)
  for the `[mcp:<tool name>]` line the handler logs before returning the
  generic error to the client.
- **Revoking a client's access** — Clerk Dashboard → **Users** → select the
  user → **OAuth applications** (or **Sessions**, depending on Clerk
  dashboard version) → revoke the MCP client's grant. The next tool call
  from that client fails auth and it has to re-run the sign-in flow.

## Related docs

- Design spec: `docs/superpowers/specs/2026-07-16-mcp-server-design.md`
- Implementation plan: `docs/superpowers/plans/2026-07-16-mcp-server.md`
