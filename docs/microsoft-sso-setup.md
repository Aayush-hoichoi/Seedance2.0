# Adding Microsoft (Entra ID) sign-in

How to make `Sign in with Microsoft` work for `@hoichoi.tv` accounts. Sign-in
itself is entirely Clerk dashboard + Entra configuration — **no code change is
needed**, and nothing in this repo has to be redeployed.

## Current state (2026-08-21)

| Fact | Value |
| --- | --- |
| Clerk instance | **development** — `pk_test_…` / `sk_test_…` in `.env.local` |
| Clerk frontend API | `lucky-scorpion-21.clerk.accounts.dev` (decoded from the publishable key) |
| Working sign-in method | **Google only** — all 24 accounts are `oauth_google`, `password_enabled: false` |
| Microsoft accounts | **zero** — the connection has never successfully created a user |
| Microsoft OAuth credentials | **Clerk's shared app** — no Hoichoi-owned Entra registration exists |
| Entra tenant | `13e520ef-9fca-4d6d-992f-6d604279cbe9` (same tenant as `TEAMS_TENANT_ID`) |

Colleagues on `@hoichoi.tv` — `shinjini.nandy@`, `ashish.mallick@`,
`sayan.maiti@` — all signed in through **Google**, so the domain resolves via
Google Workspace even though the org also runs the Entra tenant that the Teams
bot talks to. Microsoft SSO was never part of the original design: the auth spec
(`superpowers/specs/2026-07-10-clerk-model-access-design.md:20`) specifies
allowlisted email sign-up and mentions no social provider at all.

## The symptom

A first-time Microsoft sign-up is stopped by an Entra consent screen:

> **Approval required** — Clerk Development and Staging instances *(unverified)*
> This app requires your admin's approval to: Maintain access to data you have
> given it access to · Sign in and read user profile

Two causes stack:

1. A Clerk **development** instance uses Clerk's *shared* multi-tenant OAuth app
   for social providers. Enabling Microsoft is a single dashboard toggle that
   needs no client ID or secret — which is why it appears configured but is not.
   That shared app is what the tenant sees, and it is unverified.
2. The hoichoi.tv tenant **disables user consent for third-party apps** and has
   the admin-consent workflow on (hence the "Enter justification" box). So no
   user can self-consent; every signup blocks until an admin acts.

The fix is to stop using Clerk's shared app and register a Hoichoi-owned one.

## Fix — register your own Entra app

### 1. Entra app registration

Entra admin center → **App registrations** → **New registration**:

| Field | Value |
| --- | --- |
| Name | `LoglineAI Studio (Clerk)` |
| Supported account types | **Single tenant** — accounts in this organizational directory only |
| Redirect URI | Web → `https://lucky-scorpion-21.clerk.accounts.dev/v1/oauth_callback` |

Single-tenant is deliberate: it restricts sign-in to the hoichoi.tv tenant, so
personal Microsoft accounts are rejected at Microsoft rather than landing in the
users table.

Then, inside the new registration:

- **Certificates & secrets** → New client secret → copy the **Value** (not the
  Secret ID — it is shown once, and only immediately after creation).
- **API permissions** → Microsoft Graph → Delegated: `User.Read`, `openid`,
  `profile`, `email`, `offline_access`.
- **Grant admin consent for Hoichoi Technologies Private Limited.** This is the
  step that removes the approval screen — consenting tenant-wide once means no
  user ever sees a consent prompt.

### 2. Point Clerk at it

Clerk Dashboard → the `lucky-scorpion-21` instance → **SSO Connections** →
**Microsoft** → enable **Use custom credentials**:

| Clerk field | Source |
| --- | --- |
| Client ID | Application (client) ID of the registration |
| Client Secret | the secret **Value** from Certificates & secrets |

Confirm the Redirect URI shown by Clerk matches the one registered in Entra —
copy Clerk's version verbatim if they differ. Save, then retry the sign-up.

No env var changes, no deploy: the publishable/secret keys are unchanged, and
the OAuth credentials live in Clerk, never in this repo.

## The second gate

Getting past Microsoft is not the whole journey. After a successful sign-up the
user lands on the **"ask your admin"** screen, not the studio — signups are not
auto-enrolled in any project by design (`7c3a74c`, and the comment at
`app/api/webhooks/clerk/route.js:7`). An admin must add them to a project.

If Clerk's **Restrict sign-ups → Allowlist** is ever turned on as the spec
intends, that becomes a third gate: the email must also be allowlisted or Clerk
rejects the account after Microsoft has already approved it.

## Why not move to a Clerk production instance

A production instance (`pk_live_`) is the eventual right move — custom domain,
higher limits, mandatory custom credentials — but it **mints new Clerk user
IDs**. Those IDs are stored as bare `user_id text` across `project_members`,
`quotas`, `user_model_overrides`, `billing_events`, `usage_events` and the daily
rollups (`lib/db/schema.mjs`). Migrating without an ID remap orphans every one of
those rows. Custom credentials on the current instance achieve working Microsoft
sign-in with none of that churn; treat the production move as separate work with
its own migration.

## Verifying who signed up how

The Clerk Backend API records the strategy behind every account:

```bash
KEY=$(grep -E '^CLERK_SECRET_KEY=' .env.local | cut -d= -f2-)
curl -s -H "Authorization: Bearer $KEY" 'https://api.clerk.com/v1/users?limit=100' \
  | python3 -c "
import json,sys
for u in json.load(sys.stdin):
    print([e['email_address'] for e in u['email_addresses']],
          [x['provider'] for x in u['external_accounts']],
          'pw=', u['password_enabled'])
"
```

`external_accounts[].provider` is `oauth_google` or `oauth_microsoft`; an empty
list with `pw=True` means email + password. Use this to confirm the first
Microsoft account actually lands after the change.
