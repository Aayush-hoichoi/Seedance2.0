// Server-only transactional email over SMTP (Gmail by default).
//
// Best-effort by design: if SMTP isn't configured, or a send fails, we log and
// return a falsy result — email must NEVER break the access request/approval
// flow that triggers it. Configure with env (all set by you, never committed):
//   SMTP_USER          the Gmail address that sends (e.g. you@hoichoi.tv)
//   SMTP_PASS          a Gmail App Password (16 chars; needs 2-Step Verification)
//   SMTP_HOST          optional, default smtp.gmail.com
//   SMTP_PORT          optional, default 587 (STARTTLS); 465 = implicit TLS
//   NOTIFY_FROM_NAME   optional sender display name, default "loglineAI Studio"
//   NOTIFY_FROM_EMAIL  optional full "From" (wins verbatim), default name<SMTP_USER>

// Memoized per warm instance: undefined = not built yet, null = unconfigured,
// object = a live transporter. nodemailer is imported lazily so this module
// stays importable (and testable) without a send path or the dependency loaded.
let cached;

function smtpConfig() {
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!user || !pass) return null;
    const port = Number(process.env.SMTP_PORT) || 587;
    return {
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port,
        secure: port === 465,
        auth: { user, pass },
    };
}

export function emailConfigured() {
    return smtpConfig() !== null;
}

async function getTransport() {
    if (cached !== undefined) return cached;
    const cfg = smtpConfig();
    if (!cfg) {
        cached = null;
        return null;
    }
    const nodemailer = (await import('nodemailer')).default;
    cached = nodemailer.createTransport(cfg);
    return cached;
}

// Send one email. Returns { ok } — resolves (never rejects) so callers can
// treat it as fire-and-forget without a try/catch of their own.
export async function sendEmail({ to, subject, html, text }) {
    if (!to) return { ok: false, skipped: true, reason: 'no recipient' };
    const transport = await getTransport();
    if (!transport) {
        console.warn(`[notify] SMTP not configured (set SMTP_USER/SMTP_PASS) — skipping: ${subject}`);
        return { ok: false, skipped: true, reason: 'not configured' };
    }
    // From shows a display name ("loglineAI Studio") over the sending mailbox.
    // NOTIFY_FROM_EMAIL, if set, wins verbatim (may carry its own name/alias).
    const from = process.env.NOTIFY_FROM_EMAIL
        || { name: process.env.NOTIFY_FROM_NAME || 'loglineAI Studio', address: process.env.SMTP_USER };
    try {
        const info = await transport.sendMail({ from, to, subject, html, text: text || undefined });
        return { ok: true, id: info?.messageId ?? null };
    } catch (err) {
        console.error(`[notify] email send failed (${subject}):`, err.message);
        return { ok: false, error: err.message };
    }
}
