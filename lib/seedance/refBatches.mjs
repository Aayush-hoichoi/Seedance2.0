// Reference batches: each batch is a COMPLETE, independent reference set for
// one output — all batches share the prompt and settings, and one Generate
// click fires one generation per batch. Batch 1 is the mode's normal slots in
// mediaByRole; batch k≥2 lives in the SAME mediaByRole under synthetic
// `batch<k>:<role>` keys no mode ever declares, so flattenMedia / validate /
// buildTags see only batch 1 while upload, pending placeholders, drafts,
// Clear-all and hasBarContent cover every batch unchanged. The items
// themselves keep their REAL role — only the mediaByRole key is synthetic.

// One Generate click is capped at this many outputs, matching the old ×N
// batch ceiling — each output is a full priced generation.
export const MAX_OUTPUTS = 4;

const BATCH_KEY_RE = /^batch(\d+):(.+)$/;

export const batchRole = (k, role) => `batch${k}:${role}`;

// Split a mediaByRole key into its batch index and real role.
// 'reference_image' → {k: 0, role}; 'batch2:reference_image' → {k: 2, role}.
export function parseBatchRole(key) {
    const m = BATCH_KEY_RE.exec(key);
    return m ? { k: Number(m[1]), role: m[2] } : { k: 0, role: key };
}

// Extra-batch indices present (ascending). Indices can be sparse — removing a
// middle batch never renumbers the others, display order is what matters.
export function batchIndices(mediaByRole) {
    const ks = new Set();
    for (const [key, items] of Object.entries(mediaByRole || {})) {
        const { k } = parseBatchRole(key);
        if (k > 0 && items?.length) ks.add(k);
    }
    return [...ks].sort((a, b) => a - b);
}

// mediaByRole-shaped view of batch k ({realRole: items}) — feedable to the
// same MediaButtons / flattenMedia / validate / buildTags as batch 1.
export function batchMedia(mediaByRole, k) {
    const out = {};
    for (const [key, items] of Object.entries(mediaByRole || {})) {
        const parsed = parseBatchRole(key);
        if (parsed.k === k && items?.length) out[parsed.role] = items;
    }
    return out;
}

// Write a batch-k view back into the real mediaByRole (returns a NEW object).
// Roles emptied in the view are dropped, so a batch with no items left simply
// ceases to exist — no empty-batch state to carry anywhere.
export function withBatchMedia(mediaByRole, k, view) {
    const out = {};
    for (const [key, items] of Object.entries(mediaByRole || {})) {
        if (parseBatchRole(key).k !== k) out[key] = items;
    }
    for (const [role, items] of Object.entries(view || {})) {
        if (items?.length) out[batchRole(k, role)] = items;
    }
    return out;
}

// Index for a NEW batch: one past the highest in use.
export const nextBatchIndex = (mediaByRole) => Math.max(0, ...batchIndices(mediaByRole)) + 1;

// Every reference set a Generate click submits, in output order:
// [batch 1 (the mode's own slots, synthetic keys stripped), batch 2, …].
export function mediaBatches(mediaByRole) {
    return [batchMedia(mediaByRole, 0), ...batchIndices(mediaByRole).map((k) => batchMedia(mediaByRole, k))];
}

// Image mode (inline Gemini refs, separate from mediaByRole): the ref groups
// a Generate click submits. `extra` is the session's list of extra groups.
export function imageRefBatches(refs, extra) {
    return [refs || [], ...(extra || []).filter((g) => g?.length)];
}
