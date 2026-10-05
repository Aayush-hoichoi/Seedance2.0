import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../lib/gateway/authz.js';

// Project-scoped Try-On stores: the wardrobe (assets), the locked cast
// (characters) and the submitted finals (history). One route, three sibling
// tables of the same shape — the kind segment picks the table through a fixed
// map (never from user input).
//
//   GET    /api/tryon/assets?projectId=4         → { items }
//   POST   /api/tryon/characters                 { projectId, name, mediaKey, kind? , items?, model? }
//   DELETE /api/tryon/finals?id=7&projectId=4    (creator or admin; soft delete)
//
// Shared within the project (decision 2026-10-05): every member reads; the
// creator or an admin deletes. Media lives in the studio's own TOS bucket —
// rows carry only the re-presignable key.

export const runtime = 'nodejs';

const KINDS = {
    assets: { table: 'tryon_assets', named: true, media: false },
    characters: { table: 'tryon_characters', named: true, media: true },
    finals: { table: 'tryon_finals', named: false, media: true },
};

// Same shape the archive route accepts — the bucket's four prefixes.
const KEY_RE = /^(videos|uploads|images|exr)\/[\w.-]+$/;
const MEDIA_KINDS = new Set(['image', 'video']);

function bad(message, status = 400) {
    return NextResponse.json({ error: message }, { status });
}

async function ctxFor(request, projectId) {
    if (!projectId) return { error: bad('projectId is required.') };
    const auth = await gatewayContext({ projectId, permission: 'generation.create' });
    if (!auth.ok) return { error: auth.response };
    return { ctx: auth.ctx };
}

export async function GET(request, { params }) {
    const { kind } = await params;
    const spec = KINDS[kind];
    if (!spec) return bad('Unknown store.', 404);
    const projectId = Number(new URL(request.url).searchParams.get('projectId')) || null;
    const { ctx, error } = await ctxFor(request, projectId);
    if (error) return error;
    const rows = await ctx.sql.query(
        `SELECT t.*, coalesce(u.name, split_part(u.email, '@', 1)) AS creator_name
         FROM ${spec.table} t LEFT JOIN users u ON u.id = t.created_by
         WHERE t.project_id = $1 AND NOT t.deleted
         ORDER BY t.created_at DESC LIMIT 200`,
        [projectId],
    );
    return NextResponse.json({ items: rows });
}

export async function POST(request, { params }) {
    const { kind } = await params;
    const spec = KINDS[kind];
    if (!spec) return bad('Unknown store.', 404);
    const body = await request.json().catch(() => null);
    const projectId = Number(body?.projectId) || null;
    const { ctx, error } = await ctxFor(request, projectId);
    if (error) return error;

    const mediaKey = typeof body?.mediaKey === 'string' ? body.mediaKey.trim() : '';
    if (!KEY_RE.test(mediaKey)) return bad('mediaKey must be a bucket key (uploads/…, images/…, videos/…).');
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 120) : '';
    if (spec.named && !name) return bad('A name is required.');
    const mediaKind = MEDIA_KINDS.has(body?.kind) ? body.kind : 'image';

    const cols = ['project_id', 'created_by', 'media_key'];
    const vals = [projectId, ctx.user.userId, mediaKey];
    if (spec.named) { cols.push('name'); vals.push(name); }
    if (spec.media) { cols.push('kind'); vals.push(mediaKind); }
    if (kind === 'finals') {
        cols.push('items', 'model');
        vals.push(String(body?.items || '').slice(0, 500) || null, String(body?.model || '').slice(0, 80) || null);
    }
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    const [row] = await ctx.sql.query(
        `INSERT INTO ${spec.table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        vals,
    );
    return NextResponse.json({ item: row }, { status: 201 });
}

export async function DELETE(request, { params }) {
    const { kind } = await params;
    const spec = KINDS[kind];
    if (!spec) return bad('Unknown store.', 404);
    const url = new URL(request.url);
    const projectId = Number(url.searchParams.get('projectId')) || null;
    const id = Number(url.searchParams.get('id')) || null;
    if (!id) return bad('id is required.');
    const { ctx, error } = await ctxFor(request, projectId);
    if (error) return error;

    // Creator deletes their own; platform admins/owners delete anything —
    // that is the whole "locked" guarantee for cast characters.
    const isAdmin = ctx.role === 'admin' || ctx.role === 'owner';
    const rows = await ctx.sql.query(
        `UPDATE ${spec.table} SET deleted = true
         WHERE id = $1 AND project_id = $2 AND NOT deleted
           AND ($3 OR created_by = $4)
         RETURNING id`,
        [id, projectId, isAdmin, ctx.user.userId],
    );
    if (!rows.length) return bad('Not found — or locked by someone else (only the creator or an admin can remove it).', 403);
    return NextResponse.json({ ok: true });
}
