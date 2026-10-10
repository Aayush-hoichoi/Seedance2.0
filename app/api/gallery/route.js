import { NextResponse } from 'next/server';
import { getUser } from '../../../lib/auth/user.js';
import {
    listCreators,
    listGalleryProjects,
    listUserGenerations,
    listUserGenerationProjects,
    listLikedGenerations,
    listProjectGenerations,
    getProjectGenerationSummary,
} from '../../../lib/access/db.js';
import { toItem } from '../../../lib/seedance/galleryItem.mjs';

// Community gallery — every signed-in user can browse every creator's work.
//   GET /api/gallery            → { me, creators: [{ id, name, email, generations, last_at }] }
//                                 ordered newest → oldest by last_at (sidebar order)
//   GET /api/gallery?user=<id>  → that creator's generations + project facets
//   GET /api/gallery?user=<id>&project=<id> → that creator's work in one project
//   GET /api/gallery?liked=1    → { items: [...] } every liked generation (all creators)
// Each item carries a presigned URL for the archived copy of its video
// (videos/<taskId>.mp4 in TOS — pure local HMAC, no round-trip). The object
// may not exist for never-archived tasks; the client falls back to the live
// ModelArk task record and finally to an "expired" placeholder.

export const runtime = 'nodejs';
export const maxDuration = 15;

// Gallery page size. Each item carries prompts + several presigned URLs, so
// 200-row pages were ~hundreds of KB of JSON — brutal on slow connections.
// The client's "Load older" cursor makes small pages free.
const PAGE = 60;

function positiveInteger(value) {
    if (value == null || value === '') return null;
    if (!/^[1-9]\d*$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export async function GET(request) {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const params = new URL(request.url).searchParams;
    const target = params.get('user');
    try {
        // The studio history rail: the caller's OWN complete generation list
        // (from the DB), so it isn't capped by ModelArk's recent-tasks window.
        if (params.get('mine')) {
            const before = params.get('before') || null;
            if (before && before.length > 40) return NextResponse.json({ error: 'Invalid cursor.' }, { status: 400 });
            // Tiebreaker half of the cursor (the last row's task_id): without
            // it, rows sharing the boundary timestamp — batch ×N — got skipped.
            const beforeId = params.get('beforeId') || null;
            if (beforeId && beforeId.length > 200) return NextResponse.json({ error: 'Invalid cursor.' }, { status: 400 });
            // Callers on slow networks (the tools' studio picker) ask for small
            // pages via ?limit=; the studio history rail keeps the 200 default.
            const limit = positiveInteger(params.get('limit'));
            if (limit === undefined) return NextResponse.json({ error: 'Invalid limit.' }, { status: 400 });
            const size = Math.min(limit || 200, 200);
            const rows = await listUserGenerations(user.userId, size, before, null, beforeId);
            // A full page means there may be older rows — hand back a cursor.
            const last = rows.length === size ? rows[rows.length - 1] : null;
            return NextResponse.json({ items: rows.map(toItem), nextBefore: last?.created_at ?? null, nextBeforeId: last?.task_id ?? null });
        }
        if (params.get('liked')) {
            const rows = await listLikedGenerations(user.userId);
            const items = rows.map((r) => ({
                ...toItem(r),
                creator: r.user_id ? { id: r.user_id, name: r.creator_name, email: r.creator_email } : null,
            }));
            return NextResponse.json({ items });
        }
        if (params.get('projects') === '1') {
            const rows = await listGalleryProjects();
            return NextResponse.json({ projects: rows.map((row) => ({
                id: Number(row.id), name: row.name, generations: Number(row.generations),
                images: Number(row.images), videos: Number(row.videos), last_at: row.last_generation_at,
            })) });
        }
        if (!target && params.has('project')) {
            const projectId = positiveInteger(params.get('project'));
            if (projectId === undefined || projectId === null) return NextResponse.json({ error: 'Invalid project id.' }, { status: 400 });
            const before = params.get('before') || null;
            if (before && before.length > 40) return NextResponse.json({ error: 'Invalid cursor.' }, { status: 400 });
            const beforeId = params.get('beforeId') || null;
            if (beforeId && beforeId.length > 200) return NextResponse.json({ error: 'Invalid cursor.' }, { status: 400 });
            const [rows, project] = await Promise.all([
                listProjectGenerations(projectId, PAGE, before, beforeId),
                getProjectGenerationSummary(projectId),
            ]);
            if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
            const last = rows.length === PAGE ? rows[rows.length - 1] : null;
            return NextResponse.json({
                project: { id: Number(project.id), name: project.name, generations: Number(project.generations), images: Number(project.images), videos: Number(project.videos) },
                items: rows.map((row) => ({ ...toItem(row), creator: { id: row.user_id || row.creator_email || 'unknown', name: row.creator_name || 'Unknown creator', email: row.creator_email } })),
                total: Number(project.generations), nextBefore: last?.created_at ?? null, nextBeforeId: last?.task_id ?? null,
            });
        }
        if (!target) {
            // Newest → oldest by last activity: this list is only ever the
            // gallery's creators sidebar, and it should read the same way the
            // generation grid does. The admin roster keeps its own (volume)
            // order — this is the sidebar's ordering, not a global one.
            const creators = await listCreators({ order: 'recent' });
            return NextResponse.json({ me: user.userId, creators });
        }
        if (target.length > 200) return NextResponse.json({ error: 'Invalid user id.' }, { status: 400 });
        const before = params.get('before') || null;
        if (before && before.length > 40) return NextResponse.json({ error: 'Invalid cursor.' }, { status: 400 });
        const beforeId = params.get('beforeId') || null;
        if (beforeId && beforeId.length > 200) return NextResponse.json({ error: 'Invalid cursor.' }, { status: 400 });
        const projectId = positiveInteger(params.get('project'));
        if (projectId === undefined) return NextResponse.json({ error: 'Invalid project id.' }, { status: 400 });
        const limit = positiveInteger(params.get('limit'));
        if (limit === undefined) return NextResponse.json({ error: 'Invalid limit.' }, { status: 400 });
        const size = Math.min(limit || PAGE, PAGE);

        const [rows, projectRows] = await Promise.all([
            listUserGenerations(target, size, before, projectId, beforeId),
            listUserGenerationProjects(target),
        ]);
        const projects = projectRows
            .filter((row) => row.project_id != null)
            .map((row) => ({
                id: Number(row.project_id),
                name: row.project_name,
                generations: Number(row.generations),
                images: Number(row.images),
                videos: Number(row.videos),
            }));
        const total = projectId == null
            ? projectRows.reduce((sum, row) => sum + Number(row.generations), 0)
            : projects.find((project) => project.id === projectId)?.generations ?? 0;
        const last = rows.length === size ? rows[rows.length - 1] : null;
        return NextResponse.json({ items: rows.map(toItem), projects, total, nextBefore: last?.created_at ?? null, nextBeforeId: last?.task_id ?? null });
    } catch (e) {
        console.error('[gallery] failed:', e.message);
        return NextResponse.json({ error: 'Could not load the gallery.' }, { status: 502 });
    }
}
