import { NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { getDb } from '../../../../lib/db/neon.js';
import { exrProjectForUser } from '../../../../lib/byteplus/exrAccess.mjs';
import { toolBySlug } from '../../../../lib/tools/catalog.mjs';
import { toolStatus } from '../../../../lib/tools/billing.mjs';

export const runtime = 'nodejs';

// GET /api/tools/status?tool=upscale&projectId=4
// → { allowed, requestStatus, budget: { limitUsd, remainingUsd } | null }
// UI only — the tool's submit route re-checks everything.
export async function GET(request) {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const params = new URL(request.url).searchParams;
    const tool = toolBySlug(params.get('tool'));
    if (!tool) return NextResponse.json({ error: 'Unknown tool.' }, { status: 400 });
    try {
        const sql = await getDb();
        if (!sql) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503 });
        const projectId = await exrProjectForUser(sql, user, params.get('projectId'));
        if (!projectId) return NextResponse.json({ error: 'A valid project is required.' }, { status: 400 });
        return NextResponse.json({ toolId: tool.id, projectId, ...(await toolStatus(sql, { projectId, userId: user.userId, toolId: tool.id })) });
    } catch (error) {
        console.error('[tools/status] failed:', error);
        return NextResponse.json({ error: 'Could not load tool access.' }, { status: 502 });
    }
}
