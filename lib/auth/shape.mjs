// lib/auth/shape.mjs — pure mapping, shared by session and OAuth-token paths.
export function shapeUser(u) {
    if (!u) return null;
    const email = u.primaryEmailAddress?.emailAddress
        ?? u.emailAddresses?.[0]?.emailAddress
        ?? null;
    return { userId: u.id, email, role: u.publicMetadata?.role ?? null };
}
