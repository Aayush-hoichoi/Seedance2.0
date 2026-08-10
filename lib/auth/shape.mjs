// lib/auth/shape.mjs — pure mapping, shared by session and OAuth-token paths.
export function shapeUser(u) {
    if (!u) return null;
    const email = u.primaryEmailAddress?.emailAddress
        ?? u.emailAddresses?.[0]?.emailAddress
        ?? null;
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim()
        || u.fullName
        || (email ? email.split('@')[0] : null);
    return { userId: u.id, email, name, role: u.publicMetadata?.role ?? null };
}
