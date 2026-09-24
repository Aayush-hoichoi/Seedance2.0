// Post-production tools, catalogued as `models` rows (category 'tool') so they
// reuse the model access-request flow and the Budgets console unchanged.
// Browser-safe. is_default stays false — a default is an org-wide grant that
// would bypass the approval flow.
export const TOOL_CATALOG = Object.freeze([
    { id: 'tool:upscale', display: 'Video Upscale', slug: 'upscale' },
    // Budget/billing scope for EXR jobs (access approval stays on its own
    // byteplus-exr flow) — registered so Console → Budgets can cap EXR spend
    // per user or project like any other model.
    { id: 'tool:exr', display: 'EXR Output', slug: 'exr' },
]);
export const TOOL_IDS = Object.freeze(TOOL_CATALOG.map((t) => t.id));
export const toolBySlug = (slug) => TOOL_CATALOG.find((t) => t.slug === slug) || null;
