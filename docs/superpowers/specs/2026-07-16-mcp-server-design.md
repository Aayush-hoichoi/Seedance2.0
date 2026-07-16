# MCP Server for LoglineAI Studio — Design

**Date:** 2026-07-16
**Status:** Approved (brainstormed with Aayush)

## Goal

Expose the studio's generation capabilities as a remote MCP server so Claude
clients (claude.ai custom connectors, Claude Desktop, Claude Code) can connect
and act **as the signed-in user** — same model gating, project membership,
quotas, and usage attribution as the web studio.

## Approach (chosen)

Remote MCP endpoint **inside this Next.js app** — no separate service, no new
token system:

- Transport: Streamable HTTP at `/api/mcp` via `mcp-handler` (Vercel's MCP
  adapter for Next.js App Router).
- Auth: **Clerk as the OAuth authorization server** (`@clerk/nextjs` v7 ships
  MCP/OAuth support via `@clerk/mcp-tools`). claude.ai discovers auth through
  `/.well-known/oauth-protected-resource`, registers itself via Dynamic Client
  Registration, and the user signs in on the normal Clerk page with their
  existing account. Every MCP request then carries `Authorization: Bearer
  <oauth token>`; the route verifies it with Clerk and resolves `userId`.
- Rejected alternative: standalone MCP service calling the app's HTTP API —
  requires building inbound personal-access-token auth from scratch plus a
  second deployment for the same result.

## Tools (v1 — full studio parity, ~24 tools)

Scope decision (Aayush, 2026-07-16): **everything a user can do in the studio
should be doable over MCP**, permission-gated identically. Grouped:

**Catalog & access**
| Tool | Purpose | Permission / scope |
|---|---|---|
| `list_models` | Model catalog (video + image) with gating, resolutions, durations, and which models THIS user can use (`/api/access/me` logic) | any signed-in user |
| `get_my_access` | Current grants + pending requests | any signed-in user |
| `request_model_access` | Request a gated model (feeds the existing Slack approval flow) | any signed-in user |

**Projects**
| `list_projects` | Projects the user can act on | membership-scoped (admin/manager see all) |
| `create_project` / `update_project` | Create, rename, pause, archive | `project.manage` |

**Generation**
| `create_video` | Seedance video generation through the governed gateway path | `generation.create` + model grants + quotas |
| `create_image` | Image generation (Nano Banana 2/Pro, Seedream 5.0 Pro, Cinematic Studio) through the `/api/generations` logic incl. `sanitizeImageRequest` | `generation.create` + model grants + quotas |
| `get_job_status` | Poll a task until output URL is ready (video + image) | own jobs / project membership |
| `cancel_job` | Cancel a queued/running job (gateway `cancel.mjs`) | own jobs |

**History & gallery**
| `list_generations` | Recent generations for a project: prompt, status, output URLs | membership; other users' prompts require `prompt.view` |
| `get_generation` | One generation's detail + presigned output URL (covers download — the client fetches the URL directly; server-side zip stays studio-only) | as above |
| `bin_generation` | Soft-delete / restore (existing `deleted` flag semantics) | own generations |
| `like_generation` | Like / unlike | any signed-in user |
| `browse_gallery` | Community gallery: creators, per-creator items, liked feed | any signed-in user |

**Assets**
| `list_assets` | Browse/search the project's asset pool (BytePlus asset group) | `generation.create` |
| `register_asset` | Register a **public URL** into the project's asset group (existing `registerUrlAsset` flow, polls past `Processing`) | `generation.create` |
| `create_upload_url` | Presigned TOS PUT URL + final public URL, for local-file upload from Claude Code (curl), then `register_asset` | `generation.create` |
| `delete_asset` | Remove an asset from the pool | `generation.create`, own project |

**Usage & admin** (admin tools appear only if the token's user has the permission)
| `get_usage` | Spend + remaining quota per project (org rollup for admin/manager) | `usage.view` |
| `list_access_requests` / `resolve_access_request` | View + approve/deny model access requests (mirrors the Slack command) | `model.grant` |
| `list_quotas` / `set_quota` | View + edit budgets/quotas | `quota.manage` |
| `view_audit` | Audit trail | `audit.view` |

Reference media on `create_video` / `create_image`: `refs: [{ assetId, role }]`
with the studio's existing roles (`first_frame`, `reference_image`,
`reference_video`, …), resolved server-side to signed URLs via the existing
asset resolution path.

## Access model

Nothing new. Every tool declares the same permission the equivalent studio
action requires and resolves through `gatewayContext` (platform roles from
Clerk `publicMetadata.role`; seeded role → permission table applies verbatim).

Deliberate v1 exclusions (everything else is parity):
- **Provider API keys** (`key.manage`) — secrets never travel over MCP;
  console only.
- **User role management** — roles live in Clerk `publicMetadata`; Clerk
  dashboard / Users console only.
- **Workflow builder / creative agent / muapi proxy surfaces** — separate
  product surface with its own key system (`x-api-key` to api.muapi.ai);
  revisit as a separate MCP later if wanted.
- **Bulk zip download** — MCP clients fetch presigned URLs directly;
  the server-side zip stream stays a browser feature.

Invariants:
- **Gated models still gate** — denial mirrors the studio's friendly
  request-access message and points at `request_model_access`.
- **All generations log usage/billing events** under the real user + project,
  indistinguishable from studio usage.
- **Admin tools are permission-gated per call** via `gatewayContext`, exactly
  like the console routes they mirror.

## Known limitations (accepted)

- **claude.ai chat attachments cannot reach the connector** — remote MCP
  receives only JSON tool args; multi-MB base64 is not viable. Local files
  work from Claude Code (`create_upload_url` + curl + `register_asset`);
  claude.ai users upload via the studio, then use `list_assets`. An MCP upload
  widget can be revisited if this becomes a real pain point.
- Viewer role can read usage but cannot generate or browse assets — same as
  the studio.

## Architecture / key changes

1. **Routes**
   - `app/api/mcp/[transport]/route.js` — `createMcpHandler` wrapped with
     Clerk MCP auth (verify OAuth bearer token → `userId`).
   - `app/.well-known/oauth-protected-resource/route.js` — OAuth protected
     resource metadata (helpers from `@clerk/mcp-tools/next`).
2. **Middleware** — add `/api/mcp(.*)` and `/.well-known(.*)` to public
   routes; the shared `ll_auth` login gate stays untouched for the web UI
   (OAuth protects the MCP surface instead).
3. **Auth refactor** — `lib/auth/user.js` gains a sibling of `getUser()` that
   resolves the same user object from a Clerk `userId` (from the OAuth token),
   so `gatewayContext` and downstream checks work unchanged.
4. **Governed-create extraction** — the model-gating/quota/usage-logging logic
   in the byteplus create-task route (`resolveGateway`) and the image
   generation path move into `lib/gateway/` functions callable by both the
   HTTP routes and MCP tools (no duplication of governance logic).
5. **Tool modules** — small files under `lib/mcp/` (one file per tool group),
   zod input schemas, registered in the route handler.
6. **Clerk dashboard (one-time)** — enable Dynamic Client Registration.

## Testing

- `node --test tests/*.test.js tests/*.test.mjs` unit tests for: tool input
  validation, userId-based user resolution, permission mapping per tool, and
  the extracted governed-create functions (mocked sql).
- E2E: connect from claude.ai (custom connector) and Claude Code
  (`claude mcp add --transport http`) against the Vercel deployment
  (`seedance2-0`); verify sign-in flow, a gated-model denial, a real
  generation, and usage attribution in the dashboard.

## Client setup (docs to ship with this)

- claude.ai → Settings → Connectors → Add custom connector →
  `https://<domain>/api/mcp` → sign in with Clerk.
- Claude Code: `claude mcp add --transport http logline https://<domain>/api/mcp`.
- Token refresh is automatic; revocation via Clerk dashboard.
