# Seedance WhatsApp worker

Always-on WhatsApp-Web (Baileys) worker. Links **your own number** by QR, holds the
session, and sends "you're burning money" alerts to up to **5** recipients when the
Seedance app POSTs a milestone.

> ⚠️ **Not a Vercel app.** It keeps a persistent WebSocket to WhatsApp, which
> serverless can't do. Deploy to a host that stays up (Render/Railway/Fly/VPS) with
> a **persistent disk** for the session.
>
> ⚠️ **Unofficial client → against WhatsApp's ToS.** Use a **throwaway number**, keep
> the 5 recipients as **saved contacts**, and treat `auth/` as full account access.
> Low ban risk at this volume, but no appeal if it happens.

## What it exposes
- `GET  /health` → `{ ok, connected, recipients }`
- `POST /send`  (header `X-Worker-Token: <WORKER_TOKEN>`, body `{ "text": "..." }`) →
  sends the text to every `WA_RECIPIENTS` number (with anti-burst jitter).

## Env
| var | meaning |
|---|---|
| `WORKER_TOKEN` | shared secret; must match the app's `WHATSAPP_WORKER_TOKEN` |
| `WA_RECIPIENTS` | comma-separated phone numbers, international format, no `+` (e.g. `9198…,4477…`), max 5 |
| `AUTH_DIR` | session dir (default `./auth`; on a host, point at a persistent disk) |
| `PORT` | listen port (default 3000) |
| `LOG_LEVEL` | pino level (default `warn`) |

## Run locally (to scan the QR the first time)
```bash
cd whatsapp-worker
npm install
WA_RECIPIENTS="9198XXXXXXXX" WORKER_TOKEN="dev-secret" npm start
# A QR prints in the terminal. WhatsApp → Settings → Linked Devices → Link a device → scan it.
# On "connected ✓" it's live. Test:
curl -s localhost:3000/health
curl -s -X POST localhost:3000/send -H 'x-worker-token: dev-secret' \
     -H 'content-type: application/json' -d '{"text":"test alert"}'
```

## Deploy (Render, example)
1. Render → **New → Blueprint** → this repo → it reads `whatsapp-worker/render.yaml`
   (Root Directory `whatsapp-worker`). It provisions the service + a 1 GB persistent disk.
2. Set **`WA_RECIPIENTS`** in the dashboard. Copy the generated **`WORKER_TOKEN`**.
3. Open the service **Logs** → the QR prints there → scan it once. `connected ✓`.
4. Note the service URL, e.g. `https://seedance-whatsapp-worker.onrender.com`.

## Wire the Seedance app (Vercel env)
Set on the Seedance/Vercel project, then redeploy:
```
WHATSAPP_WORKER_URL   = https://seedance-whatsapp-worker.onrender.com
WHATSAPP_WORKER_TOKEN = <the WORKER_TOKEN from above>
SPEND_ALERT_STEP_USD  = 500   # optional; the milestone size
```
That's it — on every $500 of platform spend, the app POSTs `/send` and your number
messages the 5 recipients. Until `WHATSAPP_WORKER_URL` is set, the app does nothing
(no overhead).

## If the session dies
Phone offline too long / manual unlink → `logged out` in the logs. Clear the disk's
`auth/` and restart to re-scan.
