import { NextResponse } from 'next/server';
import { isAdmin } from '../../../../lib/auth/user.js';
import { getDb } from '../../../../lib/db/neon.js';

export const runtime = 'nodejs';

// Every workflow in the workspace, for the console Workflows page. Admins see
// the full picture — officials AND every user's customs (private included),
// with the style details the picker hides (look briefs stay server-side for
// users; the console is where an admin inspects them).
export async function GET() {
    if (!(await isAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const sql = await getDb();
    const rows = await sql`
        SELECT w.id, w.name, w.description, w.style, w.media, w.visibility,
               w.created_by, w.created_at, u.email AS creator_email,
               (SELECT count(*)::int FROM users
                WHERE workflow_id = w.id OR image_workflow_id = w.id) AS attached_count
        FROM workflows w LEFT JOIN users u ON u.id = w.created_by
        WHERE w.deleted_at IS NULL
        ORDER BY (w.created_by IS NOT NULL), w.name`;
    return NextResponse.json({
        items: rows.map((w) => ({
            id: w.id,
            name: w.name,
            description: w.description,
            media: w.media || 'all',
            official: !w.created_by,
            visibility: w.created_by ? w.visibility : 'public',
            creator: w.creator_email || null,
            createdAt: w.created_at,
            attachedCount: w.attached_count,
            version: w.style?.version ?? null,
            enabled: w.style?.enabled !== false,
            defaultLook: w.style?.defaultLook ?? null,
            sourceDescription: w.style?.sourceDescription ?? null,
            looks: Object.entries(w.style?.looks || {}).map(([key, look]) => ({
                key,
                name: look?.name || key,
                brief: typeof look?.brief === 'string' ? look.brief : '',
                match: Array.isArray(look?.match) ? look.match : [],
                negatives: typeof look?.negatives === 'string' ? look.negatives : '',
            })),
        })),
    });
}
