import { isStudioVideoUrlStale } from './videoUrlState.mjs';

// A provider-list refresh and an individual task poll can finish out of order.
// Completion belongs to the task, so an older response must not hide its video.
export function reconcileVideoTask(job, taskId, patch) {
    if (!taskId || job.taskId !== taskId) return job;
    if (job.status === 'done' && patch.status !== 'done') return job;

    let next = patch;
    if (job.status === 'done' && job.videoUrl && patch.videoUrl && !isStudioVideoUrlStale(job)) {
        // Replacing a still-valid signature restarts an already decoded video.
        next = { ...patch, videoUrl: job.videoUrl };
    }
    return Object.entries(next).every(([key, value]) => job[key] === value)
        ? job : { ...job, ...next };
}
