import { NextResponse } from 'next/server';
import { getUser } from '../../../../../lib/auth/user.js';
import { getMonthSpendRank } from '../../../../../lib/access/db.js';

export const runtime = 'nodejs';

// A member may see their own place on the workspace leaderboard, but not the
// identities or amounts behind anybody else's position.
export async function GET() {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const result = await getMonthSpendRank(user.userId);
    return NextResponse.json(result ?? { rank: null, userCount: 0 }, {
        headers: { 'Cache-Control': 'private, no-store' },
    });
}
