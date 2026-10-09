import { archiveKeyForTask } from './archiveKey.mjs';
import { tosPresignExpired } from './tosPresign.mjs';
import { isStudioVideoUrlStale } from './videoUrlState.mjs';

function imageGenerationId(item) {
    if (item.mediaType !== 'image') return null;
    const id = item.genId ?? item.gatewayId ?? /^job:(\d+)$/.exec(item.taskId || '')?.[1];
    return id == null ? null : String(id);
}

function sameImageUrls(left, right) {
    return left === right || (Array.isArray(left) && Array.isArray(right)
        && left.length === right.length && left.every((url, i) => url === right[i]));
}

// Merge an authenticated gallery page into locally persisted Studio history.
export function mergeStudioHistory(prev, items) {
    const toStatus = (s) => (s === 'succeeded' ? 'done' : ['queued', 'running'].includes(s) ? s : 'error');
    // The DB is the authority on which project a generation
    // billed to. Re-tag server-built (srv-*) cards whose tag is
    // missing (ModelArk merge won the race) or wrong (a past
    // reload's legacy backfill stamped them onto the home
    // project).
    const byTask = new Map(items.map((it) => [it.taskId, it]));
    const byImageGeneration = new Map(items.map((it) => [imageGenerationId(it), it]).filter(([id]) => id != null));
    let changed = false;
    const refreshed = prev.map((j) => {
        const it = (j.taskId && byTask.get(j.taskId)) || byImageGeneration.get(imageGenerationId(j));
        if (!it) return j;
        const projectId = it.projectId != null && (j.projectId == null || String(j.id).startsWith('srv-'))
            ? it.projectId : j.projectId;
        // Hydrate timing even when a cached card already has
        // the right project. Local createdAt predates submit.
        const gatewayId = it.gatewayId ?? j.gatewayId;
        const submittedAt = it.submittedAt ?? j.submittedAt;
        const finishedAt = it.finishedAt ?? j.finishedAt;
        const patch = { projectId, gatewayId, submittedAt, finishedAt };
        // Persisted image links expire too. The gallery page has just signed
        // fresh URLs; hydrate existing cards as well as newly discovered ones.
        // Match local image jobs by genId because they have no taskId yet.
        const imageUrl = it.mediaType === 'image' && (it.imageUrl || it.imageUrls?.[0]);
        if (imageUrl) {
            patch.imageUrl = imageUrl;
            patch.imageUrls = it.imageUrls?.length > 1 ? it.imageUrls : null;
            if (it.status === 'succeeded') Object.assign(patch, { status: 'done', error: null, expired: false });
        }
        // Repair expired video cache from this freshly signed gallery page.
        // Leave valid URLs alone: replacing a signature mid-preview restarts
        // the media request. A working provider URL also remains preferable
        // to an archive URL whose object has not been confirmed to exist.
        if (j.status === 'done' && it.mediaType === 'video' && it.status === 'succeeded' && it.archiveUrl
            && (!j.videoUrl || j.expired || tosPresignExpired(j.videoUrl)
                || (j.archiveKey && isStudioVideoUrlStale(j)))) {
            patch.videoUrl = it.archiveUrl;
            patch.expired = false;
            if (j.videoUrl !== it.archiveUrl) patch.urlRefreshedAt = Date.now();
        }
        if (Object.entries(patch).every(([key, value]) => key === 'imageUrls'
            ? sameImageUrls(j[key], value) : j[key] === value)) return j;
        changed = true;
        return { ...j, ...patch };
    });
    const base = changed ? refreshed : prev;
    const known = new Set(base.map((j) => j.taskId).filter(Boolean));
    // Image jobs have no provider task id: the server keys them
    // 'job:<genId>'. Skip any we already track locally by genId,
    // else the same image shows twice (local card + server merge).
    const knownGen = new Set(base.map(imageGenerationId).filter((id) => id != null));
    const isDupImage = (it) => knownGen.has(imageGenerationId(it));
    const added = items
        .filter((it) => it.taskId && !known.has(it.taskId) && !isDupImage(it))
        .map((it) => {
            const isImage = it.mediaType === 'image';
            return {
                id: `srv-${it.taskId}`,
                taskId: it.taskId,
                mediaType: it.mediaType || 'video',
                projectId: it.projectId ?? null,
                prompt: it.prompt || '',
                userPrompt: it.userPrompt || null,
                style: it.style || null,
                modeId: isImage ? 'image' : null,
                refs: it.refs || null,
                options: { model: it.modelId, resolution: it.resolution, duration: it.duration, ratio: it.ratio },
                model: it.modelId,
                status: toStatus(it.status),
                genId: null,
                gatewayId: it.gatewayId ?? null,
                submittedAt: it.submittedAt ?? null,
                finishedAt: it.finishedAt ?? null,
                videoUrl: isImage ? null : (it.archiveUrl || null),
                archiveKey: isImage ? null : (it.taskId ? archiveKeyForTask(it.taskId) : null),
                imageUrl: isImage ? (it.imageUrl || null) : null,
                imageUrls: isImage ? (it.imageUrls || null) : null,
                // A finished EXR survives a reload: the gallery row
                // carries its URL/key/resolution from exr_jobs.
                exrUrl: it.exrUrl || null,
                exrArchiveKey: it.exrArchiveKey || null,
                exrStatus: it.exrUrl ? 'succeeded' : null,
                exrMetadata: it.exrResolution ? { resolution: it.exrResolution } : null,
                error: null,
                liked: !!it.liked,
                deleted: false,
                deletedAt: null,
                createdAt: it.createdAt ? new Date(it.createdAt).getTime() : Date.now(),
            };
        });
    return added.length ? [...base, ...added].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) : base;
}
