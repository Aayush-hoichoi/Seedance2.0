import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../../lib/gateway/authz.js';
import { workflowAccessFor } from '../../../../../lib/gateway/db.js';
import { enhanceStyleDescription } from '../../../../../lib/gateway/workflowRefresh.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60;

// "Enhance description with AI" in the create-workflow modal: rough style
// idea in, rich editable description out. Same gate as creating a workflow.
export async function POST(request) {
    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { sql, user, isPlatformAdmin } = auth.ctx;
    if (!isPlatformAdmin && await workflowAccessFor(sql, user.userId) !== 'approved') {
        return NextResponse.json({ error: 'Workflows need admin approval first.' }, { status: 403 });
    }
    const body = await request.json().catch(() => null);
    const description = typeof body?.description === 'string' ? body.description.trim() : '';
    if (description.length < 3) return NextResponse.json({ error: 'Type a rough style idea first.' }, { status: 400 });
    const enhanced = await enhanceStyleDescription({
        name: typeof body?.name === 'string' ? body.name.slice(0, 80) : '',
        description: description.slice(0, 2000),
        media: ['all', 'video', 'image'].includes(body?.media) ? body.media : 'all',
    });
    if (!enhanced) return NextResponse.json({ error: 'The enhancer is unavailable right now — your own words work fine too.' }, { status: 503 });
    return NextResponse.json({ description: enhanced });
}
