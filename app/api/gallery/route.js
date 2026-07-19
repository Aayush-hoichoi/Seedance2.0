import { NextResponse } from 'next/server';
import { getUser } from '../../../lib/auth/user.js';
import { listCreators, listUserGenerations, listLikedGenerations } from '../../../lib/access/db.js';
import { toItem } from '../../../lib/seedance/galleryItem.mjs';

// Community gallery — every signed-in user can browse every creator's work.
//   GET /api/gallery            → { me, creators: [{ id, name, email, generations, last_at }] }
//   GET /api/gallery?user=<id>  → { items: [...] } that creator's generations
//   GET /api/gallery?liked=1    → { items: [...] } every liked generation (all creators)
// Each item carries a presigned URL for the archived copy of its video
// (videos/<taskId>.mp4 in TOS — pure local HMAC, no round-trip). The object
// may not exist for never-archived tasks; the client falls back to the live
// ModelArk task record and finally to an "expired" placeholder.

export const runtime = 'nodejs';
export const maxDuration = 15;

export async function GET(request) {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const params = new URL(request.url).searchParams;
    const target = params.get('user');
    try {
        // The studio history rail: the caller's OWN complete generation list
        // (from the DB), so it isn't capped by ModelArk's recent-tasks window.
        if (params.get('mine')) {
            const rows = await listUserGenerations(user.userId);
            return NextResponse.json({ items: rows.map(toItem) });
        }
        if (params.get('liked')) {
            const rows = await listLikedGenerations(user.userId);
            const items = rows.map((r) => ({
                ...toItem(r),
                creator: r.user_id ? { id: r.user_id, name: r.creator_name, email: r.creator_email } : null,
            }));
            return NextResponse.json({ items });
        }
        if (!target) {
            const creators = await listCreators();
            return NextResponse.json({ me: user.userId, creators });
        }
        if (target.length > 200) return NextResponse.json({ error: 'Invalid user id.' }, { status: 400 });
        const rows = await listUserGenerations(target);
        return NextResponse.json({ items: rows.map(toItem) });
    } catch (e) {
        console.error('[gallery] failed:', e.message);
        return NextResponse.json({ error: 'Could not load the gallery.' }, { status: 502 });
    }
}
