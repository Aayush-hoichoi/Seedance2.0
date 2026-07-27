# Seedance WhatsApp worker

Always-on WhatsApp-Web (Baileys) worker. Links **your own number** by QR, holds the
session, and sends "you're burning money" alerts to up to **5** recipients when the
Seedance app POSTs a milestone.

The linked session is stored in **Postgres** (`DATABASE_URL`), not on disk, and the
worker **self-pings** to stay awake — so it runs on **Render's free plan** (no
persistent disk, survives restarts/redeploys without re-scanning the QR).

> ⚠️ **Not a Vercel app.** It keeps a persistent WebSocket to WhatsApp, which
> serverless can't do. Deploy to a host that stays up (Render/Railway/Fly/VPS).
>
> ⚠️ **Unofficial client → against WhatsApp's ToS.** Use a **throwaway number**, keep
> the recipients as **saved contacts**, and treat the `wa_auth` table as full account
> access. Low ban risk at this volume, but no appeal if it happens.

## What it exposes
- `GET  /health` → `{ ok, connected, recipients }`
- `POST /send`  (header `X-Worker-Token: <WORKER_TOKEN>`, body `{ "text": "..." }`) →
  sends the text to every `WA_RECIPIENTS` number (with anti-burst jitter).

## Env
| var | required | meaning |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon/Postgres — the linked session persists in a `wa_auth` table (auto-created). Use the same DB as the app. |
| `WORKER_TOKEN` | ✅ | shared secret; must match the app's `WHATSAPP_WORKER_TOKEN` |
| `WA_RECIPIENTS` | ✅ | comma-separated phone numbers, intl format, no `+` (e.g. `9198…,4477…`), max 5 |
| `WA_SESSION_ID` | | session key (default `default`; change only to link more than one number) |
| `KEEPALIVE_URL` | | public URL to self-ping every 10 min; defaults to `RENDER_EXTERNAL_URL` (auto on Render) |
| `PORT` / `LOG_LEVEL` | | listen port (Render injects its own) / pino level (default `warn`) |

## Deploy on Render (free)
1. **New → Web Service → "Public Git Repository"** → paste
   `https://github.com/Aayush-hoichoi/Seedance2.0` → Connect.
2. Configure:
   - **Root Directory:** `whatsapp-worker`  ← critical (builds only the worker)
   - **Runtime:** Docker · **Branch:** `main` · **Instance Type:** Free
   - **Environment:** `DATABASE_URL`, `WORKER_TOKEN`, `WA_RECIPIENTS`
   - **Health Check Path:** `/health`
3. **Create** → wait for the build → open **Logs** → the **QR prints** → scan it
   (WhatsApp → Settings → Linked Devices). Wait for **`connected ✓`**.
4. Copy the service URL (e.g. `https://seedance-whatsapp-worker.onrender.com`) and
   check `‹url›/health` → `{"ok":true,"connected":true,...}`.

Public-repo connect has no auto-deploy webhook — hit **Manual Deploy** if you change
the code later. (Optional extra safety: point a free [UptimeRobot](https://uptimerobot.com)
monitor at `/health` every 5 min as a backup keep-alive.)

## Wire the Seedance app (Vercel env)
```
WHATSAPP_WORKER_URL   = https://seedance-whatsapp-worker.onrender.com
WHATSAPP_WORKER_TOKEN = <the WORKER_TOKEN above>
SPEND_ALERT_STEP_USD  = 500   # optional; the milestone size
```
Until `WHATSAPP_WORKER_URL` is set, the app does nothing (no overhead).

## Run locally
```bash
cd whatsapp-worker
npm install
DATABASE_URL="postgres://…" WORKER_TOKEN="dev-secret" WA_RECIPIENTS="9198XXXXXXXX" npm start
# QR prints → scan once. Then:
curl -s localhost:3000/health
curl -s -X POST localhost:3000/send -H 'x-worker-token: dev-secret' \
     -H 'content-type: application/json' -d '{"text":"test alert"}'
```

## If the session dies
Phone unlinked / logged out → the worker clears `wa_auth` and re-issues a QR in the
logs automatically; just re-scan.
