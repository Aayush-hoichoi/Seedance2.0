import { NextResponse } from 'next/server';
import { getUser } from '../../../../../lib/auth/user.js';
import { getDb } from '../../../../../lib/db/neon.js';
import { emitEvent } from '../../../../../lib/gateway/db.js';
import {
    exrProjectForUser,
    getExrAccess,
    requestExrAccess,
} from '../../../../../lib/byteplus/exrAccess.mjs';

export const runtime = 'nodejs';

async function context(user, requestedProjectId) {
    const sql = await getDb();
    if (!sql) return { error: NextResponse.json({ error: 'Access store unavailable.' }, { status: 503 }) };
    const projectId = await exrProjectForUser(sql, user, requestedProjectId);
    if (!projectId) return { sql, projectId: null };
    return { sql, projectId };
}

export async function GET(request) {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!user.email) return NextResponse.json({ error: 'No email on your account.' }, { status: 400 });
    const queryProjectId = new URL(request.url).searchParams.get('projectId');
    const ctx = await context(user, queryProjectId);
    if (ctx.error) return ctx.error;
    if (!ctx.projectId) return NextResponse.json({ projectId: null, status: 'unavailable', granted: false });
    if (user.role === 'admin') return NextResponse.json({ projectId: ctx.projectId, status: 'approved', granted: true, admin: true });
    return NextResponse.json(await getExrAccess(ctx.sql, { userId: user.userId, projectId: ctx.projectId }));
}

export async function POST(request) {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!user.email) return NextResponse.json({ error: 'No email on your account.' }, { status: 400 });
    const body = await request.json().catch(() => null);
    const ctx = await context(user, body?.projectId);
    if (ctx.error) return ctx.error;
    if (!ctx.projectId) return NextResponse.json({ error: 'A workspace project is required.' }, { status: 400 });
    if (user.role === 'admin') return NextResponse.json({ projectId: ctx.projectId, status: 'approved', granted: true, admin: true });
    const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : null;
    const result = await requestExrAccess(ctx.sql, {
        userId: user.userId,
        userEmail: user.email,
        projectId: ctx.projectId,
        note,
    });
    if (result.fresh) {
        await emitEvent(ctx.sql, {
            projectId: ctx.projectId,
            userId: user.userId,
            type: 'exr.access.requested',
            payload: { requestId: result.requestId, userName: user.name || user.email || user.userId },
        });
    }
    return NextResponse.json(result, { status: result.fresh ? 201 : 200 });
}
