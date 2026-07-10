import { NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { getApprovedModelIds, getRequestsForUser } from '../../../../lib/access/db.js';
import { MODELS } from '../../../../lib/seedance/constants.js';

export const runtime = 'nodejs';

export async function GET() {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const approved = await getApprovedModelIds(user.userId);
    const openIds = MODELS.filter((m) => !m.gated).map((m) => m.id);
    const allowedModelIds = [...new Set([...openIds, ...approved])];
    const requests = await getRequestsForUser(user.userId);
    return NextResponse.json({ allowedModelIds, requests });
}
