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

    const models = await sql`SELECT m.*, v.kind, v.caps FROM models m
        LEFT JOIN model_versions v ON v.id = m.current_version_id
        WHERE m.active = true ORDER BY m.category, m.display_name`;
    const grants = await sql`SELECT * FROM project_model_grants WHERE project_id = ${projectId}`;
    const overrides = await sql`SELECT * FROM user_model_overrides WHERE project_id = ${projectId} AND user_id = ${user.userId}`;
    const defaultModelIds = models.filter((m) => m.is_default).map((m) => m.id);

    const items = models.map((m) => {
        const decision = effectiveAccess({ modelId: m.id, now: new Date(), grants, overrides, defaultModelIds });
        return {
            id: m.id, displayName: m.display_name, category: m.category, kind: m.kind,
            caps: m.caps, isDefault: m.is_default, allowed: decision.allowed, rule: decision.rule,
            maxResolution: decision.maxResolution ?? null,
        };
    });
    return NextResponse.json({ items });
}
