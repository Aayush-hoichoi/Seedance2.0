// "You're burning money" alert: fire a WhatsApp message every time cumulative
// platform spend crosses a new $STEP milestone ($500 by default). Reuses the
// gateway_state atomic-advance pattern (same as sweep.mjs) so each milestone
// sends EXACTLY ONCE even under concurrent settles — no new table, no schema bump.
//
// Scope: TOTAL platform spend (SUM of settlement+failure billing_events), matching
// the provider bill. Per-user alerting would key the bucket by user_id — left out
// of v1. Fully inert until WHATSAPP_WORKER_URL is set.

import { postWhatsappAlert } from '../notify/whatsapp.mjs';

export const STEP_USD = Number(process.env.SPEND_ALERT_STEP_USD) || 500;
const STATE_KEY = 'spend.alert';

// Pure: which $step milestone a cumulative total has reached (0 = under one step).
export function bucketFor(total, step = STEP_USD) {
    if (!(step > 0)) return 0;
    return Math.floor((Number(total) || 0) / step);
}

// Pure: the alert copy for a crossed milestone.
export function spendAlertText(bucket, total, step = STEP_USD) {
    const crossed = (bucket * step).toLocaleString('en-US');
    const now = Math.round(Number(total) || 0).toLocaleString('en-US');
    return `⚠️ Burning money — platform spend just crossed $${crossed}. Total is now ~$${now}.`;
}

// Best-effort, called after a settlement. Never throws — spend alerting must not
// break settlement/billing.
// ponytail: a SUM over billing_events per settle is fine at current volume; if the
// table grows huge, keep a running counter in gateway_state and increment it here.
export async function checkSpendAlert(sql) {
    try {
        // Feature off (no worker configured) → skip entirely, incl. the SUM.
        if (!(process.env.WHATSAPP_WORKER_URL || '').trim()) return;

        const [row] = await sql`SELECT COALESCE(SUM(COALESCE(cost_usd, est_cost_usd, 0)), 0)::float8 AS total
            FROM billing_events WHERE event_type IN ('settlement', 'failure')`;
        const total = row?.total ?? 0;
        const bucket = bucketFor(total);

        const [prev] = await sql`SELECT (value->>'bucket')::int AS bucket FROM gateway_state WHERE key = ${STATE_KEY}`;
        if (prev?.bucket == null) {
            // First run: record the current milestone as a BASELINE and send nothing,
            // so we don't blast one message per historical $500 crossing on rollout.
            await sql`INSERT INTO gateway_state (key, value, updated_at)
                VALUES (${STATE_KEY}, ${JSON.stringify({ bucket })}, now())
                ON CONFLICT (key) DO NOTHING`;
            return;
        }
        if (bucket <= prev.bucket) return;

        // Atomic advance: only the settle that actually moves the stored bucket
        // forward gets a row back and sends — concurrent settles at the same/lower
        // milestone get nothing, so each threshold fires exactly once.
        const [won] = await sql`UPDATE gateway_state
            SET value = ${JSON.stringify({ bucket })}, updated_at = now()
            WHERE key = ${STATE_KEY} AND (value->>'bucket')::int < ${bucket}
            RETURNING (value->>'bucket')::int AS bucket`;
        if (!won) return;

        await postWhatsappAlert(spendAlertText(bucket, total));
    } catch (err) {
        console.error('[spend-alert] check failed:', err.message);
    }
}
