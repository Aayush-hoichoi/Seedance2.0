// Server-only. Resolves the current Clerk user + admin role. Reads role from
// publicMetadata so no custom JWT session-claim template is needed.
import { auth, currentUser, clerkClient } from '@clerk/nextjs/server';
import { shapeUser } from './shape.mjs';

export async function getUser() {
    const { userId } = await auth();
    if (!userId) return null;
    return shapeUser(await currentUser());
}

// OAuth-token path (MCP): same shape, resolved via the backend API.
export async function getUserById(userId) {
    if (!userId) return null;
    try {
        const client = await clerkClient();
        return shapeUser(await client.users.getUser(userId));
    } catch (error) {
        console.error('[auth] getUserById failed:', error.message);
        return null;
    }
}

export async function isAdmin() {
    const user = await getUser();
    return user?.role === 'admin';
}
