import { redirect } from 'next/navigation';
import SeedanceStudio from './SeedanceStudio.jsx';
import { getUser } from '../../lib/auth/user.js';
import { getDb } from '../../lib/db/neon.js';
import { canEnterStudio } from '../../lib/gateway/access.mjs';

export const metadata = {
    title: 'loglineAI Studio',
    description: 'Generate cinematic AI video, images, and more with loglineAI Studio.',
};

export default async function SeedancePage() {
    // The studio is project-scoped: a plain member with no memberships waits on
    // /projects ("ask an admin to add you") instead of an empty studio. The
    // generation API enforces the same rule server-side — this is the door,
    // not the lock. DB hiccups fail open: the API gate still holds.
    const user = await getUser();
    if (user && !canEnterStudio(user.role, await membershipCount(user.userId))) {
        redirect('/projects');
    }
    return <SeedanceStudio />;
}

async function membershipCount(userId) {
    try {
        const sql = await getDb();
        if (!sql) return 1; // fail open
        const [row] = await sql`SELECT count(*)::int AS n FROM project_memberships m
            JOIN projects p ON p.id = m.project_id AND p.archived_at IS NULL
            WHERE m.user_id = ${userId}`;
        return row?.n ?? 1;
    } catch {
        return 1; // fail open
    }
}
