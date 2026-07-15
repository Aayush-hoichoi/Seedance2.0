import { verifyWebhook } from '@clerk/nextjs/webhooks';
import { userFromClerkEvent } from '../../../../lib/access/clerkUser.mjs';
import { upsertUser, deleteUserData } from '../../../../lib/access/db.js';

export const runtime = 'nodejs';

// New members are NOT auto-enrolled in any project — an admin must add them
// (studio shows an "ask your admin" screen until then). Auto-joining Default
// gave every signup silent access to the org-default models.

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
