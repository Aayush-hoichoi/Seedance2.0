import { NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { canReviewIssues, listIssueReports } from '../../../../lib/issueReports.mjs';

export const runtime = 'nodejs';

export async function GET() {
    if (!canReviewIssues(await getUser())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    return NextResponse.json({ issues: await listIssueReports() });
}
