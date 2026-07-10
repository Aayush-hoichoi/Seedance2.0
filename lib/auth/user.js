// Server-only. Resolves the current Clerk user + admin role. Reads role from
// currentUser().publicMetadata so no custom JWT session-claim template is needed.

import { auth, currentUser } from '@clerk/nextjs/server';

export async function getUser() {
    const { userId } = await auth();
    if (!userId) return null;
    const user = await currentUser();
    const email = user?.primaryEmailAddress?.emailAddress
        ?? user?.emailAddresses?.[0]?.emailAddress
        ?? null;
    const role = user?.publicMetadata?.role ?? null;
    return { userId, email, role };
}

export async function isAdmin() {
    const user = await getUser();
    return user?.role === 'admin';
}
