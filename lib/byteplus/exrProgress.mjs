// Honest progress for EXR/upscale jobs. BytePlus reports no percentage while
// a task runs — only "processing" — so everything here is derived from data
// we actually have: the job's real stage, its live queue position, and how
// long jobs like it ACTUALLY took (median of recent successes). The fraction
// is therefore an estimate against history — capped below 1 so the bar never
// lies about being done — unless the provider ever starts sending a percent
// (result.progress), which then wins.
//
// Pure so it unit-tests under `node --test`; the API layer supplies the
// queue-ahead count and the historical median.

const SUBMIT_FRACTION = 0.05; // the sliver shown while the job ships to BytePlus
const CAP = 0.95;             // an estimate never reads as finished

export function exrProgress(job, { queueAhead = 0, typicalMs = null, now = Date.now() } = {}) {
    const status = job?.status;
    if (status === 'succeeded') return { stage: 'done', fraction: 1, queuePosition: null, elapsedMs: null, etaMs: null, typicalMs };
    if (status === 'failed' || status === 'rejected' || status === 'cancelled') {
        return { stage: 'failed', fraction: null, queuePosition: null, elapsedMs: null, etaMs: null, typicalMs };
    }
    if (status === 'queued' || status === 'reserving') {
        return { stage: 'queued', fraction: 0, queuePosition: queueAhead + 1, elapsedMs: null, etaMs: null, typicalMs };
    }
    // processing: submitting until the provider accepts, enhancing after.
    if (!job?.provider_task_id) {
        return { stage: 'submitting', fraction: SUBMIT_FRACTION, queuePosition: null, elapsedMs: null, etaMs: null, typicalMs };
    }
    const startedAt = job.started_at ? new Date(job.started_at).getTime() : null;
    const elapsedMs = startedAt ? Math.max(0, now - startedAt) : null;
    const providerFraction = Number(job.result?.progress);
    let fraction;
    if (Number.isFinite(providerFraction) && providerFraction > 0) {
        // Provider percents may arrive as 0–1 or 0–100.
        fraction = Math.min(providerFraction > 1 ? providerFraction / 100 : providerFraction, CAP);
    } else if (elapsedMs != null && typicalMs > 0) {
        fraction = Math.min(SUBMIT_FRACTION + (1 - SUBMIT_FRACTION) * (elapsedMs / typicalMs), CAP);
    } else {
        fraction = SUBMIT_FRACTION; // no history yet: show the stage, not a guess
    }
    const etaMs = elapsedMs != null && typicalMs > 0 ? Math.max(0, typicalMs - elapsedMs) : null;
    return { stage: 'enhancing', fraction, queuePosition: null, elapsedMs, etaMs, typicalMs };
}

// Display order for the step tracker; 'failed' replaces whichever step broke.
export const EXR_STAGES = ['queued', 'submitting', 'enhancing', 'done'];
