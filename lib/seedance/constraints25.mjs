// Seedance 2.5 task-type parameter constraints, per the official tutorial
// (docs.byteplus.com/en/docs/ModelArk/2607688, "Task types and constraints").
//
// 2.5 decides the task SUBTYPE (reference-to-video / video editing / video
// extension) from the prompt at RUN time — the client can't know which one
// will fire. Editing demands ratio=adaptive + duration=-1 and a 4–30s source
// clip; extension demands ratio=adaptive; first-frame / first-last-frame
// generation demands ratio=adaptive. Violations fail AFTER submit with
// InvalidParameter.TaskTypeConstraint — the task is already priced by then.
//
// So whenever a reference video is attached on 2.5 the pills lock to the one
// configuration every subtype accepts (adaptive + Auto) — which is also
// BytePlus's own recommended config for video-attached 2.5 tasks. Pure +
// dependency-lite (kind string in, plain object out) so it stays unit-testable
// under `node --test` without loading the ESM constants.
//
// `omni_reference_task_type` (doc revision 2026-09-04) lets the request declare
// the subtype up front, which changes what must lock:
//   reference — no ratio/duration constraints at all
//   extend    — ratio=adaptive; duration stays a free [4,30] / -1 choice
//   edit      — ratio=adaptive + duration=-1 (output follows the source clip)
//   auto      — the model still decides at render time, so keep the
//               conservative both-locked config that every subtype accepts
//
// Live-probed 2026-09-08 (one real 480p task each, both SUCCEEDED end-to-end):
//   reference + video ref + ratio=16:9 + duration=8   cgt-20260908152940-prdr4
//   extend    + video ref + duration=6                cgt-20260908152943-bv5s4
// So the declared-subtype releases are verified, not doc-assumed.

export const MODEL_25_KIND = 'full_2_5';

// Valid omni_reference_task_type values, per the create-task API reference.
export const OMNI_TASK_TYPES = ['auto', 'reference', 'edit', 'extend'];

// Editing tasks only accept source clips in this duration window; shorter
// clips still work as plain style/motion references (those allow 2–30s).
export const EDIT_CLIP_MIN_SEC = 4;
export const EDIT_CLIP_MAX_SEC = 30;

// The lock for the current selection, or null when every setting is free.
// `duration: null` means duration stays a free choice; a number means the
// pill must hold exactly that value (-1 = Auto).
export function seedance25Constraints({ modelKind, hasVideoInput = false, hasFirstFrame = false, taskType = 'auto' }) {
    if (modelKind !== MODEL_25_KIND) return null;
    // A declared reference task releases the video lock — but NOT the
    // first-frame ratio pin below: first/last-frame output always follows the
    // first-frame image, whatever the declared subtype.
    if (hasVideoInput && taskType !== 'reference') {
        if (taskType === 'extend') {
            return {
                ratio: 'adaptive',
                duration: null,
                reason: 'Video extension only accepts Adaptive ratio — the output keeps the aspect ratio of the clip being extended. Duration is yours to pick.',
            };
        }
        return {
            ratio: 'adaptive',
            duration: -1,
            reason: taskType === 'edit'
                ? 'Video edits only accept Adaptive ratio and Auto duration — the output follows the source clip.'
                : 'With a video attached, Seedance 2.5 may run your prompt as a video edit or extension — those tasks only accept Adaptive ratio and Auto duration (the output follows the source clip). Set the Task pill to Reference to unlock both.',
        };
    }
    if (hasFirstFrame) {
        return {
            ratio: 'adaptive',
            duration: null,
            reason: 'Seedance 2.5 first-frame tasks only accept Adaptive ratio — the output keeps the aspect ratio of your first-frame image.',
        };
    }
    return null;
}

// Upload-time warning for a reference video that an editing prompt would
// reject. Returns a user-facing string, or null when the clip is edit-safe
// (or its duration is unknown).
export function editClipWarning(modelKind, durationSec, name = 'This clip') {
    if (modelKind !== MODEL_25_KIND || !Number.isFinite(durationSec)) return null;
    if (durationSec >= EDIT_CLIP_MIN_SEC && durationSec <= EDIT_CLIP_MAX_SEC) return null;
    const len = `${durationSec.toFixed(1)}s`;
    return `${name} is ${len} — Seedance 2.5 can only EDIT clips of ${EDIT_CLIP_MIN_SEC}–${EDIT_CLIP_MAX_SEC}s. It still works as a style/motion reference, but a prompt that asks to change/remove/replace something in it will be rejected.`;
}
