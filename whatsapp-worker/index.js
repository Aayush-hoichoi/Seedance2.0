// Always-on WhatsApp-Web worker (Baileys). Links your own number by QR, keeps the
// session alive, and exposes ONE authed endpoint the Seedance app calls to send a
// spend alert to up to 5 recipients.
//
// ⚠️  Runs a persistent WebSocket to WhatsApp — CANNOT run on Vercel/serverless.
//     Deploy to a host that stays up. The session lives in Postgres (not a local
//     disk), so it survives restarts even on hosts with NO persistent disk
//     (Render free). A built-in self-ping keeps free tiers from idle-sleeping.
// ⚠️  Unofficial client → against WhatsApp ToS. Use a throwaway number; keep the
//     recipients as saved contacts; the wa_auth table == full account access.
//
// Env:
//   PORT            listen port (default 3000; Render injects its own)
//   WORKER_TOKEN    shared secret; callers must send it as X-Worker-Token
//   WA_RECIPIENTS   comma-separated phone numbers in intl format, e.g. 91987...,44779...
//   DATABASE_URL    Postgres (Neon) — stores the linked session in wa_auth (REQUIRED)
//   WA_SESSION_ID   session row key (default 'default'; change to run >1 number)
//   KEEPALIVE_URL   public URL to self-ping every 10m (defaults to RENDER_EXTERNAL_URL)
//   LOG_LEVEL       pino level (default warn)

import { createServer } from 'node:http';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys';
import { neon } from '@neondatabase/serverless';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { usePostgresAuthState } from './pgAuthState.js';

const PORT = Number(process.env.PORT) || 3000;
const TOKEN = (process.env.WORKER_TOKEN || '').trim();
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const SESSION_ID = process.env.WA_SESSION_ID || 'default';
const KEEPALIVE_URL = (process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
const MAX_RECIPIENTS = 5;
const RECIPIENTS = (process.env.WA_RECIPIENTS || '')
    .split(',').map((s) => s.replace(/[^\d]/g, '')).filter(Boolean).slice(0, MAX_RECIPIENTS);
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

let sock = null;
let connected = false;

async function start() {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required — the WhatsApp session is stored in Postgres.');
    const sql = neon(DATABASE_URL);
    const { state, saveCreds, clearAuth } = await usePostgresAuthState(sql, SESSION_ID);
    // Announce the CURRENT WhatsApp-Web version — a stale one is rejected with a
    // 405 close before any QR is issued. Browsers.* sets the linked-device label.
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[whatsapp] using WA-web version ${version.join('.')}`);
    sock = makeWASocket({ version, auth: state, browser: Browsers.macOS('Desktop'), logger });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
        const { connection, lastDisconnect, qr } = u;
        if (qr) {
            console.log('\n[whatsapp] Open WhatsApp → Settings → Linked Devices → Link a device, and scan:\n');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') { connected = true; console.log('[whatsapp] connected ✓'); }
        if (connection === 'close') {
            connected = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === DisconnectReason.loggedOut) {
                console.error('[whatsapp] logged out — clearing the stored session and re-issuing a QR…');
                await clearAuth().catch(() => {});
                setTimeout(() => start().catch((e) => console.error('[whatsapp] restart failed:', e.message)), 2000);
                return;
            }
            console.warn(`[whatsapp] connection closed (code ${code ?? '?'}) — reconnecting in 3s…`);
            setTimeout(() => start().catch((e) => console.error('[whatsapp] reconnect failed:', e.message)), 3000);
        }
    });
}

// Send `text` to every configured recipient, with a little jitter between sends so
// 5 identical messages don't go out as one instant burst (anti-spam hygiene).
async function sendToAll(text) {
    if (!connected || !sock) throw new Error('whatsapp session not connected');
    if (!RECIPIENTS.length) throw new Error('WA_RECIPIENTS is empty');
    const sent = [];
    for (const num of RECIPIENTS) {
        await sock.sendMessage(`${num}@s.whatsapp.net`, { text });
        sent.push(num);
        await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 700)));
    }
    return sent;
}

async function readJson(req) {
    let body = '';
    for await (const chunk of req) {
        body += chunk;
        if (body.length > 64 * 1024) throw new Error('body too large');
    }
    return JSON.parse(body || '{}');
}

createServer(async (req, res) => {
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'GET' && req.url === '/health') {
        return json(200, { ok: true, connected, recipients: RECIPIENTS.length });
    }
    if (req.method === 'POST' && req.url === '/send') {
        if (TOKEN && req.headers['x-worker-token'] !== TOKEN) return json(401, { ok: false, error: 'unauthorized' });
        let text;
        try { text = String((await readJson(req)).text || '').trim(); }
        catch { return json(400, { ok: false, error: 'invalid JSON body' }); }
        if (!text) return json(400, { ok: false, error: 'text is required' });
        try { return json(200, { ok: true, sent: await sendToAll(text) }); }
        catch (e) { return json(503, { ok: false, error: e.message }); }
    }
    return json(404, { ok: false, error: 'not found' });
}).listen(PORT, () => console.log(`[worker] listening on :${PORT} — ${RECIPIENTS.length} recipient(s)`));

// Free-tier keep-alive: hit our own public URL every 10 min so the host doesn't
// idle-sleep (which would drop the WhatsApp socket). Render injects
// RENDER_EXTERNAL_URL; locally KEEPALIVE_URL is unset so this is a no-op.
if (KEEPALIVE_URL) {
    const ping = () => fetch(`${KEEPALIVE_URL.replace(/\/+$/, '')}/health`).catch(() => {});
    setInterval(ping, 10 * 60 * 1000);
    console.log(`[worker] keep-alive: self-ping ${KEEPALIVE_URL}/health every 10m`);
}

start().catch((e) => { console.error('[whatsapp] failed to start:', e.message); process.exit(1); });
