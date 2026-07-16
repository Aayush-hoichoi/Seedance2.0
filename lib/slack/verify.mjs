// Verify that an interaction POST genuinely came from Slack, using the app's
// signing secret. https://api.slack.com/authentication/verifying-requests-from-slack
import crypto from 'node:crypto';

// rawBody must be the exact request body string used to compute the signature.
// Returns true only for a fresh, correctly-signed request.
export function verifySlackSignature({ signingSecret, signature, timestamp, rawBody }) {
    if (!signingSecret || !signature || !timestamp) return false;
    // Replay guard: reject anything older than 5 minutes (or with a bad clock).
    const ageSec = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(ageSec) || ageSec > 300) return false;
    const expected = 'v0=' + crypto.createHmac('sha256', signingSecret)
        .update(`v0:${timestamp}:${rawBody}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
