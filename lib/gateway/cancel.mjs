// Cancel a generation (design §4.7 / §6): queued → cancelled free (release
// the reservation); running → best-effort provider cancel, cost stays if the
// provider already billed. Shared by the DELETE API route and expiry/revoke.

import { emitEvent, insertBillingEvent, resolveApiKey } from './db.js';
import { adapterFor } from './providers/registry.mjs';
import * as google from './providers/google.mjs';

export async function cancelJob(sql, job, { reason = 'cancelled' } = {}) {
    const [updated] = await sql`UPDATE jobs
        SET status = 'cancelled', finished_at = now(), error = ${JSON.stringify({ message: reason })}
        WHERE id = ${job.id} AND status IN ('queued', 'running')
        RETURNING *`;
    if (!updated) return null; // already terminal

    // Free the budget reservation.
    await insertBillingEvent(sql, {
        eventType: 'release', generationId: job.id, projectId: job.project_id,
        userId: job.user_id, modelId: job.model_id, modelVersionId: job.model_version_id,
        providerId: job.provider_id, units: null, estCostUsd: null, costUsd: null, pricingSnapshot: null,
    });

    // Best-effort provider-side cancel for in-flight work.
    if (updated.provider_task_id || updated.batch_job_name) {
        const providerId = updated.batch_job_name ? 'google' : (updated.provider_id || 'byteplus');
        const auth = await resolveApiKey(sql, { providerId, projectId: job.project_id });
        if (auth) {
            // A provider with no cancel endpoint (kie.ai) answers ok and lets its
            // task finish; our row is already cancelled and the result discarded.
            if (updated.batch_job_name) await google.cancelBatch({ batchName: updated.batch_job_name, apiKey: auth.key });
            else await adapterFor(providerId).cancel({ job: updated, apiKey: auth.key });
        }
    }

    await emitEvent(sql, {
        projectId: job.project_id, userId: job.user_id,
        type: 'job.status_changed', payload: { jobId: job.id, status: 'cancelled', reason },
    });
    return updated;
}
