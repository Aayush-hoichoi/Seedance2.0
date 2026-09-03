import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../lib/gateway/authz.js';
import { apiError } from '../../../lib/gateway/httpError.mjs';
import { effectiveAccess } from '../../../lib/gateway/access.mjs';

// Effective model catalog for the caller in a project (design §7): each model
// with { allowed, rule } so the picker can explain WHY something is locked.

export const runtime = 'nodejs';

export async function GET(request) {
    const projectId = Number(new URL(request.url).searchParams.get('projectId')) || null;
    if (!projectId) return apiError('BAD_REQUEST', 'projectId is required.');
    const auth = await gatewayContext({ projectId });
    if (!auth.ok) return auth.response;
    const { sql, user } = auth.ctx;

    // provider_name mirrors the gateway's route pick (lib/gateway/db.js:32-34):
    // the top-priority active route is the one a generation would actually use.
    const models = await sql`SELECT m.*, v.kind, v.caps,
            (SELECT p.display_name FROM provider_routes r
                JOIN providers p ON p.id = r.provider_id
                WHERE r.model_version_id = v.id AND r.status = 'active'
                ORDER BY r.priority ASC LIMIT 1) AS provider_name
        FROM models m
        LEFT JOIN model_versions v ON v.id = m.current_version_id
        WHERE m.active = true ORDER BY m.category, m.display_name`;
    const grants = await sql`SELECT * FROM project_model_grants WHERE project_id = ${projectId}`;
    const overrides = await sql`SELECT * FROM user_model_overrides WHERE project_id = ${projectId} AND user_id = ${user.userId}`;
    const defaultModelIds = models.filter((m) => m.is_default).map((m) => m.id);

    const items = models.map((m) => {
        const decision = effectiveAccess({ modelId: m.id, now: new Date(), grants, overrides, defaultModelIds });
        return {
            id: m.id, displayName: m.display_name, category: m.category, kind: m.kind,
            provider: m.provider_name ?? null,
            caps: m.caps, isDefault: m.is_default, allowed: decision.allowed, rule: decision.rule,
            maxResolution: decision.maxResolution ?? null,
        };
    });
    return NextResponse.json({ items });
}
