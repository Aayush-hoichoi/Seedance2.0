// Pure. The deterministic TOS object key a finished generation is archived
// under (see /api/byteplus/archive POST). Shared by the archive route (write)
// and the gallery (read): knowing only a taskId is enough to re-presign the
// long-lived copy of its video.

export function archiveKeyForTask(taskId) {
    if (typeof taskId !== 'string' || !taskId.trim()) return null;
    return `videos/${taskId.trim().replace(/[^\w.-]+/g, '_')}.mp4`;
}
