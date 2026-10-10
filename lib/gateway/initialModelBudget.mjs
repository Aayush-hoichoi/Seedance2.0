// These full Seedance tiers require an explicit per-user, per-project starter
// budget before any access grant can make them usable.
export const INITIAL_BUDGET_MODEL_IDS = new Set([
    'seedance-2.0',
    'seedance-2.5',
    'seedance-2.0-sensitive',
]);

export function requiresInitialModelBudget(modelId) {
    return INITIAL_BUDGET_MODEL_IDS.has(modelId);
}

export async function hasInitialModelBudget(sql, { projectId, userId, modelId }) {
    if (!requiresInitialModelBudget(modelId)) return true;
    const [quota] = await sql`SELECT id FROM quotas
        WHERE project_id = ${projectId} AND user_id = ${userId} AND model_id = ${modelId}
          AND type = 'usd' AND "window" = 'lifetime' AND hard_limit > 0 AND deleted_at IS NULL
        LIMIT 1`;
    return !!quota;
}
