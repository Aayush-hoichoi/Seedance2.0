// Build the durable reference item used by validation, submission and history.
// Inspection metadata is trusted because it comes from the browser reading the
// selected File; upload responses only provide storage location information.
export function mediaItemFromUpload(slot, name, upload, metadata = {}) {
    const finite = (value) => (Number.isFinite(value) ? value : undefined);
    return {
        kind: slot.kind,
        role: slot.role,
        url: upload.url,
        previewUrl: upload.url,
        tosKey: upload.key || null,
        name,
        isImage: slot.kind === 'image',
        durationSec: finite(metadata.durationSec),
        width: finite(metadata.width),
        height: finite(metadata.height),
        fps: finite(metadata.fps),
    };
}
