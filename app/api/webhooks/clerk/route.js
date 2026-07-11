import { verifyWebhook } from '@clerk/nextjs/webhooks';
import { userFromClerkEvent } from '../../../../lib/access/clerkUser.mjs';
import { upsertUser, deleteUserData } from '../../../../lib/access/db.js';
import { getDb } from '../../../../lib/db/neon.js';

export const runtime = 'nodejs';

// Clerk organizations mirror into the gateway `organizations` table.
async function syncOrg(evt) {
    const sql = await getDb();
    if (!sql || !evt.data?.id) return;
    if (evt.type === 'organization.deleted') {
        await sql`UPDATE organizations SET deleted_at = now() WHERE id = ${evt.data.id}`;
        return;
    }
    await sql`INSERT INTO organizations (id, name, slug)
        VALUES (${evt.data.id}, ${evt.data.name ?? null}, ${evt.data.slug ?? null})
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug, deleted_at = NULL`;
}

// New signups join the Default project automatically so they can generate
// with org-default models right away (admins tighten from the console).
async function enrollInDefaultProject(userId) {
    const sql = await getDb();
    if (!sql || !userId) return;
    const [project] = await sql`SELECT p.id FROM projects p
        JOIN organizations o ON o.id = p.org_id AND o.deleted_at IS NULL
        WHERE p.name = 'Default' AND p.archived_at IS NULL LIMIT 1`;
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
        } else if (evt.type?.startsWith('organization.')) {
            await syncOrg(evt);
        }
        // Other event types are acknowledged and ignored.
    } catch (err) {
        console.error('[clerk-webhook] handler failed:', err.message);
        return new Response('Handler error', { status: 500 }); // 5xx → Svix retries
    }

    return new Response('ok', { status: 200 });
}
