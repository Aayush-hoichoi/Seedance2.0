// Pure model-access decision. Dependency-injected (gated + approved sets passed
// in, not imported) so it runs under `node --test` without loading ESM constants.

export function canUseModel({ modelId, gatedModelIds, approvedModelIds }) {
    if (!modelId) return false;
    if (!gatedModelIds.includes(modelId)) return true; // open model — no grant needed
    return approvedModelIds.includes(modelId);         // gated — needs an approved grant
}
