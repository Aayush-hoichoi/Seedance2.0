import { NextResponse } from 'next/server';
import { getUser } from '../../../../../lib/auth/user.js';
import { setUserRole, deleteUserData } from '../../../../../lib/access/db.js';

// Admin user management. Clerk is the source of truth; Neon is updated
// immediately as well so the admin UI's refetch never races the webhook.
//   PATCH  { role: 'admin' | null } → grant/remove the admin role
//   DELETE                          → remove the user from the platform
// Self-targeting is blocked — an admin can't demote or delete themselves,
// which is what keeps the platform from locking out its last admin.

export const runtime = 'nodejs';

const CLERK_API = 'https://api.clerk.com/v1';

async function clerkFetch(path, init = {}) {
    const key = process.env.CLERK_SECRET_KEY?.trim();
    if (!key) throw new Error('CLERK_SECRET_KEY is not configured.');
    const res = await fetch(`${CLERK_API}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...init.headers },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Clerk API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json().catch(() => ({}));
}

async function requireAdmin(id) {
    const admin = await getUser();
    if (!admin || admin.role !== 'admin') {
        return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
    if (!id || typeof id !== 'string' || id.length > 200) {
        return { error: NextResponse.json({ error: 'Invalid user id.' }, { status: 400 }) };
    }
    if (id === admin.userId) {
        return { error: NextResponse.json({ error: 'You can’t change your own account — ask another admin.' }, { status: 400 }) };
    }
    return { admin };
}

export async function PATCH(request, { params }) {
    const { id } = await params;
    const { error } = await requireAdmin(id);
    if (error) return error;

    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }); }
    const role = body?.role ?? null;
    if (role !== 'admin' && role !== 'manager' && role !== null) {
        return NextResponse.json({ error: 'role must be "admin", "manager" or null.' }, { status: 400 });
    }

    try {
        // Shallow-merge metadata PATCH: role:null deletes the key in Clerk.
        await clerkFetch(`/users/${encodeURIComponent(id)}/metadata`, {
            method: 'PATCH',
            body: JSON.stringify({ public_metadata: { role } }),
        });
        await setUserRole(id, role);
        return NextResponse.json({ ok: true, id, role });
    } catch (e) {
        console.error('[admin/users] role change failed:', e.message);
        return NextResponse.json({ error: 'Role change failed — Clerk rejected the update.' }, { status: 502 });
    }
}

export async function DELETE(_request, { params }) {
    const { id } = await params;
    const { error } = await requireAdmin(id);
    if (error) return error;

    try {
        await clerkFetch(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
        // Same cleanup the user.deleted webhook performs — done inline so the
        // admin UI reflects the removal immediately.
        await deleteUserData(id);
        return NextResponse.json({ ok: true, id });
    } catch (e) {
        console.error('[admin/users] delete failed:', e.message);
        return NextResponse.json({ error: 'Removal failed — Clerk rejected the delete.' }, { status: 502 });
    }
}
