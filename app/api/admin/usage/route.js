import { NextResponse } from 'next/server';
import { isAdmin } from '../../../../lib/auth/user.js';
import { getUsagePerUser, getUsagePerUserModel } from '../../../../lib/access/db.js';

export const runtime = 'nodejs';

export async function GET() {
    if (!(await isAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const [perUser, perUserModel] = await Promise.all([getUsagePerUser(), getUsagePerUserModel()]);
    return NextResponse.json({ perUser, perUserModel });
}
