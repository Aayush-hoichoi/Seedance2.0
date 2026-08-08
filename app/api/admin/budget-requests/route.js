import { NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { canReviewBudgetRequests, listBudgetRequests } from '../../../../lib/budgetRequests.mjs';

export const runtime = 'nodejs';

export async function GET() {
    if (!canReviewBudgetRequests(await getUser())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    return NextResponse.json({ requests: await listBudgetRequests() });
}
