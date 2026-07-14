import { verifyWebhook } from '@clerk/nextjs/webhooks';
import { userFromClerkEvent } from '../../../../lib/access/clerkUser.mjs';
import { upsertUser, deleteUserData } from '../../../../lib/access/db.js';
import { getDb } from '../../../../lib/db/neon.js';

export const runtime = 'nodejs';

// New members join the Default project automatically so they can generate with
// the default models right away (admins tighten from the console). This is a
// single-tenant deployment with no Clerk organizations — there is exactly one
// workspace, so the one Default project is unambiguous.
async function enrollInDefaultProject(userId) {
    const sql = await getDb();
    if (!sql || !userId) return;
    const [project] = await sql`SELECT id FROM projects
        WHERE name = 'Default' AND archived_at IS NULL ORDER BY id ASC LIMIT 1`;
    if (!project) return; // migration not run yet
    await sql`INSERT INTO project_memberships (project_id, user_id, role, added_by)
        VALUES (${project.id}, ${userId}, 'member', 'clerk-webhook')
        ON CONFLICT (project_id, user_id) DO NOTHING`;
}

// Clerk → Neon sync. Verified with Svix using CLERK_WEBHOOK_SIGNING_SECRET.
// Public route (Clerk calls it server-to-server, no session) — see middleware.
export async function POST(request) {
    let evt;
    try {
        evt = await verifyWebhook(request);
    } catch (err) {
        console.error('[clerk-webhook] verification failed:', err.message);
        return new Response('Webhook verification failed', { status: 400 });
    }

    try {
        if (evt.type === 'user.created' || evt.type === 'user.updated') {
            const user = userFromClerkEvent(evt.data);
            if (user) await upsertUser(user);
            if (evt.type === 'user.created') await enrollInDefaultProject(evt.data?.id);
        } else if (evt.type === 'user.deleted') {
            if (evt.data?.id) await deleteUserData(evt.data.id);
        }
        // Organization events are ignored — this deployment doesn't use Clerk orgs.
    } catch (err) {
        console.error('[clerk-webhook] handler failed:', err.message);
        return new Response('Handler error', { status: 500 }); // 5xx → Svix retries
    }

    return new Response('ok', { status: 200 });
}
