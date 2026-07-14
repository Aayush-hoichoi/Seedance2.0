// Idempotent gateway seed data: roles, permissions, providers, and the model
// catalog (aliases → versions → provider routes). Runs once per process from
// getDb(); every statement is ON CONFLICT DO NOTHING so operator edits made
// later in the console are never overwritten.
// Design: docs/superpowers/specs/2026-07-11-model-gateway-design.md §1/§10.

const ROLES = [
    ['owner', 'Everything, incl. role assignment. At least one must exist.'],
    ['admin', 'Manage projects, members, model access, quotas, keys.'],
    ['manager', 'Manage members and budgets within assigned projects.'],
    ['member', 'Generate with allowed models; view own usage.'],
    ['viewer', 'Read-only dashboards and usage reports.'],
];

const PERMISSIONS = [
    ['project.manage', 'Create/rename/pause/archive projects'],
    ['member.manage', 'Add/remove project members, set roles'],
    ['model.grant', 'Grant/revoke models on projects'],
    ['override.manage', 'Per-user allow/deny overrides'],
    ['quota.manage', 'Create/edit budgets and quotas'],
    ['key.manage', 'Provider API keys (create/rotate/retire)'],
    ['usage.view', 'View usage and cost reports'],
    ['audit.view', 'View the audit trail'],
    ['generation.create', 'Submit generation jobs'],
    ['prompt.view', 'See prompts of other users’ generations'],
];

// role → permissions. owner/admin get everything (spread below).
const ROLE_PERMISSIONS = {
    owner: PERMISSIONS.map(([id]) => id),
    admin: PERMISSIONS.map(([id]) => id),
    manager: ['member.manage', 'quota.manage', 'usage.view', 'generation.create', 'prompt.view'],
    member: ['generation.create', 'usage.view'],
    viewer: ['usage.view'],
};

// Alias catalog. version_tag is the provider-facing model id; the same env
// overrides the studio already uses keep working (see lib/seedance/constants.js).
function catalog() {
    const env = process.env;
    return [
        // alias, display, category, is_default, kind, provider, provider_model_id, caps, route
        {
            id: 'seedance-2.0', display: 'Seedance 2.0', category: 'video', isDefault: false, kind: 'full',
            provider: 'byteplus',
            providerModelId: env.NEXT_PUBLIC_SEEDANCE_MODEL_ID || 'dreamina-seedance-2-0-260128',
            caps: { supports1080p: true, supports4k: true },
            route: { mode: 'interactive', status: 'active' },
        },
        {
            id: 'seedance-2.0-fast', display: 'Seedance 2.0 Fast', category: 'video', isDefault: false, kind: 'fast',
            provider: 'byteplus',
            providerModelId: env.NEXT_PUBLIC_SEEDANCE_FAST_MODEL_ID || 'dreamina-seedance-2-0-fast-260128',
            caps: { supports1080p: false, supports4k: false },
            route: { mode: 'interactive', status: 'active' },
        },
        {
            id: 'seedance-2.0-mini', display: 'Seedance 2.0 Mini', category: 'video', isDefault: true, kind: 'mini',
            provider: 'byteplus',
            providerModelId: env.NEXT_PUBLIC_SEEDANCE_MINI_MODEL_ID || 'dreamina-seedance-2-0-mini-260615',
            caps: { supports1080p: false, supports4k: false },
            route: { mode: 'interactive', status: 'active' },
        },
        {
            id: 'seedream-5.0-pro', display: 'Seedream 5.0 Pro', category: 'image', isDefault: false, kind: 'seedream_pro',
            provider: 'byteplus',
            providerModelId: env.SEEDREAM_MODEL_ID || 'seedream-5-0-260128',
            caps: {},
            route: { mode: 'interactive', status: 'active' },
        },
        {
            id: 'nano-banana-pro', display: 'Nano Banana Pro', category: 'image', isDefault: false, kind: 'nano_banana_pro',
            provider: 'google',
            providerModelId: env.NANO_BANANA_PRO_MODEL_ID || 'gemini-3-pro-image-preview',
            caps: {},
            // Interactive (synchronous) generateContent — seconds, full price. The
            // async Batch API was removed as too slow for the studio. Jobs fail
            // with a clear error until GOOGLE_API_KEY is set.
            route: { mode: 'interactive', status: 'active', timeoutSeconds: 300 },
        },
        {
            id: 'nano-banana-2', display: 'Nano Banana 2', category: 'image', isDefault: true, kind: 'nano_banana_2',
            provider: 'google',
            providerModelId: env.NANO_BANANA_2_MODEL_ID || 'gemini-2.5-flash-image',
            caps: {},
            route: { mode: 'interactive', status: 'active', timeoutSeconds: 300 },
        },
    ];
}

export async function seedGateway(sql) {
    for (const [id, description] of ROLES) {
        await sql`INSERT INTO roles (id, description) VALUES (${id}, ${description}) ON CONFLICT DO NOTHING`;
    }
    for (const [id, description] of PERMISSIONS) {
        await sql`INSERT INTO permissions (id, description) VALUES (${id}, ${description}) ON CONFLICT DO NOTHING`;
    }
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
        for (const perm of perms) {
            await sql`INSERT INTO role_permissions (role_id, permission_id) VALUES (${role}, ${perm}) ON CONFLICT DO NOTHING`;
        }
    }
    await sql`INSERT INTO providers (id, display_name) VALUES ('byteplus', 'BytePlus ModelArk'), ('google', 'Google Gemini') ON CONFLICT DO NOTHING`;

    for (const m of catalog()) {
        await sql`INSERT INTO models (id, display_name, category, is_default, active)
            VALUES (${m.id}, ${m.display}, ${m.category}, ${m.isDefault}, true)
            ON CONFLICT DO NOTHING`;
        const [version] = await sql`INSERT INTO model_versions (model_id, version_tag, kind, caps)
            VALUES (${m.id}, ${m.providerModelId}, ${m.kind}, ${JSON.stringify(m.caps)})
            ON CONFLICT (model_id, version_tag) DO UPDATE SET kind = EXCLUDED.kind
            RETURNING id`;
        await sql`UPDATE models SET current_version_id = ${version.id}
            WHERE id = ${m.id} AND current_version_id IS NULL`;
        await sql`INSERT INTO provider_routes
            (model_version_id, provider_id, provider_model_id, priority, status, mode, timeout_seconds)
            VALUES (${version.id}, ${m.provider}, ${m.providerModelId}, 1,
                    ${m.route.status}, ${m.route.mode}, ${m.route.timeoutSeconds ?? null})
            ON CONFLICT (model_version_id, provider_id) DO NOTHING`;
    }
}
