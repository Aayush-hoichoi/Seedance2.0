import { NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { requestAccess } from '../../../../lib/access/db.js';
import { GATED_MODEL_IDS } from '../../../../lib/seedance/constants.js';

export const runtime = 'nodejs';

export async function POST(request) {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }); }
    const { modelId, note } = body || {};
    if (!GATED_MODEL_IDS.includes(modelId)) {
        return NextResponse.json({ error: 'That model does not require a request.' }, { status: 400 });
    }
    if (!user.email) return NextResponse.json({ error: 'No email on your account.' }, { status: 400 });
    await requestAccess(user.userId, user.email, modelId, typeof note === 'string' ? note.slice(0, 500) : null);
    return NextResponse.json({ ok: true, status: 'pending' });
}
