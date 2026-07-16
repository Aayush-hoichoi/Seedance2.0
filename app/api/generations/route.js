import { after } from 'next/server';
import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../lib/gateway/authz.js';
import { getUser } from '../../../lib/auth/user.js';
import { apiError } from '../../../lib/gateway/httpError.mjs';
import { processQueue } from '../../../lib/gateway/processor.mjs';
import { enqueueGeneration } from '../../../lib/gateway/enqueue.mjs';

// The gateway submit pipeline (design §7):
// AuthN → membership → effectiveAccess → quota+reservation → enqueue → 202.
// The pipeline itself lives in lib/gateway/enqueue.mjs (shared with the MCP
// create_image tool) — it does its own gatewayContextFor(user, {...}) check,
// so this route only resolves the signed-in user, validates the body shape,
// and fires the queue kick.

export const runtime = 'nodejs';
export const maxDuration = 300; // after(processQueue) polls providers past the default timeout

export async function POST(request) {
    const body = await request.json().catch(() => null);
    if (!body?.projectId || !body?.modelId || !body?.request) {
        return apiError('BAD_REQUEST', 'projectId, modelId and request are required.');
    }
    const user = await getUser();
    if (!user) return apiError('UNAUTHORIZED', 'Sign in required.');

    const result = await enqueueGeneration({
        user, projectId: body.projectId, modelId: body.modelId,
        request: body.request, options: body.options ?? null, priority: body.priority,
    });
    if (result.enqueued) after(() => processQueue().catch(() => {}));

    return NextResponse.json(result.body, { status: result.status });
}

// List generations: own by default; whole project with usage.view + membership.
export async function GET(request) {
    const url = new URL(request.url);
    const projectId = Number(url.searchParams.get('projectId')) || null;
    const scope = url.searchParams.get('scope') === 'project' ? 'project' : 'mine';
    // Optional media-type filter (video | image). Applied server-side so the
    // newest-100 window isn't consumed by the other type — a project with 1000s
    // of videos would otherwise bury every image job past the LIMIT.
    const catParam = url.searchParams.get('category');
    const category = catParam === 'image' || catParam === 'video' ? catParam : null;
    const auth = await gatewayContext(projectId ? { projectId, permission: scope === 'project' ? 'usage.view' : 'generation.create' } : {});
    if (!auth.ok) return auth.response;
    const { sql, user, role } = auth.ctx;

    const rows = projectId
        ? (scope === 'project'
            ? await sql`SELECT * FROM jobs WHERE project_id = ${projectId}
                AND (${category}::text IS NULL OR coalesce(request_body->>'category', 'video') = ${category})
                ORDER BY created_at DESC LIMIT 100`
            : await sql`SELECT * FROM jobs WHERE project_id = ${projectId} AND user_id = ${user.userId}
                AND (${category}::text IS NULL OR coalesce(request_body->>'category', 'video') = ${category})
                ORDER BY created_at DESC LIMIT 100`)
        : await sql`SELECT * FROM jobs WHERE user_id = ${user.userId}
            AND (${category}::text IS NULL OR coalesce(request_body->>'category', 'video') = ${category})
            ORDER BY created_at DESC LIMIT 100`;

    const rolePerms = await sql`SELECT role_id, permission_id FROM role_permissions`;
    const seePrompts = rolePerms.some((r) => r.role_id === role && r.permission_id === 'prompt.view');
    const items = rows.map((j) => ({
        ...j,
        // Q5: viewers see costs/metadata only — prompts stay with the creator
        // and manager+ roles (enforced here, not just hidden in the UI).
        request_body: (j.user_id === user.userId || seePrompts) ? j.request_body : { category: j.request_body?.category ?? null },
    }));
    return NextResponse.json({ items });
}
