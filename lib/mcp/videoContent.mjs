// lib/mcp/videoContent.mjs — pure: prompt + resolved ref URLs → ModelArk
// create-task content array. Shape grounded against the studio's real
// contentItem() builder (lib/seedance/client.js) — image_url/video_url each
// nest { url } under their own key, plus a sibling `role`. Only the
// 'reference_video' role denotes a video ref (see REF_ROLES in schemas.mjs);
// the rest (first_frame/last_frame/reference_image) are always images.
const VIDEO_ROLES = new Set(['reference_video']);

export function buildVideoContent({ prompt, refs = [] }) {
    const items = refs.map((r) => (VIDEO_ROLES.has(r.role)
        ? { type: 'video_url', role: r.role, video_url: { url: r.url } }
        : { type: 'image_url', role: r.role, image_url: { url: r.url } }));
    return [{ type: 'text', text: prompt }, ...items];
}
