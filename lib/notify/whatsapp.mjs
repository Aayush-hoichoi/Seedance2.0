// Best-effort WhatsApp alert delivery. POSTs the message to the always-on Baileys
// worker (whatsapp-worker/), which holds the linked WhatsApp-Web session and fans
// the text out to its configured recipients. Mirrors lib/notify/slack.mjs: if the
// worker URL isn't set, or the POST fails/times out, we log and move on — alerting
// must NEVER break the caller. This is ops signalling, not user-facing error copy.
//
// Env:
//   WHATSAPP_WORKER_URL     base URL of the worker, e.g. https://wa.example.com
//   WHATSAPP_WORKER_TOKEN   shared secret sent as X-Worker-Token (worker verifies)
// Recipients live on the WORKER (WA_RECIPIENTS), never here — no phone numbers in
// this repo/app env.

const workerUrl = () => (process.env.WHATSAPP_WORKER_URL || '').trim();
const workerToken = () => (process.env.WHATSAPP_WORKER_TOKEN || '').trim();
const TIMEOUT_MS = 8000;

export async function postWhatsappAlert(text) {
    const base = workerUrl();
    if (!base) return { ok: false, skipped: true };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(`${base.replace(/\/+$/, '')}/send`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-worker-token': workerToken() },
            body: JSON.stringify({ text }),
            signal: ctl.signal,
        });
        if (!res.ok) {
            console.warn(`[notify] whatsapp worker responded ${res.status}`);
            return { ok: false };
        }
        return { ok: true };
    } catch (err) {
        console.warn('[notify] whatsapp post failed:', err.message);
        return { ok: false };
    } finally {
        clearTimeout(timer);
    }
}
