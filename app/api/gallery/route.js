import { NextResponse } from 'next/server';
import { getUser } from '../../../lib/auth/user.js';
import { listCreators, listUserGenerations, listLikedGenerations } from '../../../lib/access/db.js';
import { presignGetUrl, encodePath, TOS_ENDPOINT } from '../../../lib/byteplus/tosSign.js';
import { archiveKeyForTask } from '../../../lib/seedance/archiveKey.mjs';
import { MODELS } from '../../../lib/seedance/constants.js';

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

const BUCKET = process.env.TOS_BUCKET?.trim() || 'seedance-studio-assets';

function presignArchive(taskId) {
    const ak = process.env.ARK_AK?.trim();
    const sk = process.env.ARK_SK?.trim();
    const key = archiveKeyForTask(taskId);
    if (!ak || !sk || !key) return null;
    const host = `${BUCKET}.${TOS_ENDPOINT}`;
    return presignGetUrl({ host, path: `/${encodePath(key)}`, ak, sk, expiresSec: 604800 });
}

// One DB row → the item shape the gallery/liked clients render.
function toItem(r) {
    return {
        taskId: r.task_id,
        modelId: r.model_id,
        modelName: MODELS.find((m) => m.id === r.model_id)?.name ?? r.model_id ?? 'Seedance',
        resolution: r.resolution,
        duration: r.duration,
        ratio: r.ratio,
        mode: r.mode,
        status: r.status,
        createdAt: r.created_at,
        prompt: r.generated_prompt || r.user_prompt || '',
        userPrompt: r.user_prompt || null,
        style: r.style || null,
        refs: Array.isArray(r.refs) && r.refs.length ? r.refs : null,
        liked: !!r.liked,
        archiveUrl: presignArchive(r.task_id),
    };
}

export async function GET(request) {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const params = new URL(request.url).searchParams;
    const target = params.get('user');
    try {
        if (params.get('liked')) {
            const rows = await listLikedGenerations();
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
