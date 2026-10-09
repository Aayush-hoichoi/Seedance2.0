// Submission to recorded completion, including provider waiting and archival.
// Never use local card creation, provider updated_at, or the output clip length.
export function formatGenerationTime(submittedAt, finishedAt) {
    if (submittedAt == null || submittedAt === '' || finishedAt == null || finishedAt === '') return null;
    const start = new Date(submittedAt).getTime();
    const end = new Date(finishedAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    const seconds = Math.round((end - start) / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remaining = seconds % 60;
    if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(remaining).padStart(2, '0')}s`;
    if (minutes) return `${minutes}m ${String(remaining).padStart(2, '0')}s`;
    return `${remaining}s`;
}

export const GENERATION_TIME_DESCRIPTION = 'Time from submission to recorded completion, including waiting and saving the video.';
