import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../lib/gateway/authz.js';
import { userWorkflowIds, workflowStyle } from '../../../../lib/gateway/db.js';
import { polishPrompt } from '../../../../lib/gateway/workflowPolish.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Rewrite a prompt in the caller's ATTACHED workflow style (the slot for the
// given media). Best-effort: no attached workflow, no key, or a model hiccup
// all return the prompt unchanged with polished:false — the studio then
// generates from the raw prompt rather than failing the click.
export async function POST(request) {
    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { sql, user, isPlatformAdmin } = auth.ctx;
    const body = await request.json().catch(() => null);
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return NextResponse.json({ error: 'Prompt is empty.' }, { status: 400 });
    const media = body?.media === 'image' ? 'image' : 'video';

    const attached = await userWorkflowIds(sql, user.userId);
    const workflowId = attached[media];
    const style = workflowId
        ? await workflowStyle(sql, workflowId, { userId: user.userId, isAdmin: isPlatformAdmin, media })
        : null;
    if (!style) return NextResponse.json({ prompt, polished: false });

    const polished = await polishPrompt({ style, prompt });
    return NextResponse.json({
        prompt: polished ?? prompt,
        polished: !!polished,
        workflowId,
    });
}
