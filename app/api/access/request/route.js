import { NextResponse } from 'next/server';
import { getUser } from '../../../../lib/auth/user.js';
import { requestAccess } from '../../../../lib/access/db.js';
import { getDb } from '../../../../lib/db/neon.js';
import { GATED_MODEL_IDS, IMAGE_GATED_MODEL_IDS, supportedResolutionsFor } from '../../../../lib/seedance/constants.js';
import { notifySlackAccessRequested } from '../../../../lib/notify/slack.mjs';

export const runtime = 'nodejs';

export async function POST(request) {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }); }
    const { modelId, note, projectId, maxResolution } = body || {};
    if (!GATED_MODEL_IDS.includes(modelId) && !IMAGE_GATED_MODEL_IDS.includes(modelId)) {
        return NextResponse.json({ error: 'That model does not require a request.' }, { status: 400 });
    }
    // The requested quality tier must be one the model can output; stored as the
    // canonical ladder token so tier comparisons never fight casing. Optional —
    // a request without one asks for the model's full range. The ladder also
    // drives the upgrade decision (wanted tier vs the live grant's cap).
    const supported = supportedResolutionsFor(modelId) ?? [];
    let tier = null;
    if (maxResolution != null) {
        tier = supported.find((t) => t.toLowerCase() === String(maxResolution).toLowerCase()) ?? null;
        if (!tier) return NextResponse.json({ error: 'That quality is not available on this model.' }, { status: 400 });
    }
    if (!user.email) return NextResponse.json({ error: 'No email on your account.' }, { status: 400 });
    // The request is scoped to a project — approval grants access there. Require
    // it and verify membership so a crafted call can't request for a project the
    // user isn't in (the studio always sends the user's current project).
    const pid = Number.isInteger(projectId) ? projectId : Number(projectId);
    if (!Number.isInteger(pid) || pid <= 0) {
        return NextResponse.json({ error: 'A project is required to request access.' }, { status: 400 });
    }
    const sql = await getDb();
    if (!sql) return NextResponse.json({ error: 'Access store unavailable.' }, { status: 503 });
    const [member] = await sql`SELECT p.name FROM project_memberships m
        JOIN projects p ON p.id = m.project_id
        WHERE m.project_id = ${pid} AND m.user_id = ${user.userId} LIMIT 1`;
    if (!member) return NextResponse.json({ error: 'You are not a member of that project.' }, { status: 403 });
    const cleanNote = typeof note === 'string' ? note.slice(0, 500) : null;
    const { id, status, fresh, currentMax } = await requestAccess(user.userId, user.email, modelId, cleanNote, pid, tier, supported);
    // Post to Slack only on a FRESH ask — a duplicate over a still-pending
    // request (or a stray click on a live grant) must not re-ping the channel.
    // Fresh covers: new/re-opened requests, a tier bump on a pending one, and a
    // tier UPGRADE parked on a live grant (the card shows current → wanted).
    // The id rides the Approve/Deny buttons so the interaction handler knows the target.
    if (fresh) {
        await notifySlackAccessRequested({
            id, email: user.email, modelId, projectName: member.name, note: cleanNote, maxResolution: tier,
            upgradeFrom: status === 'upgrade_pending' ? (currentMax ?? 'any') : null,
        }).catch(() => {});
    }
    return NextResponse.json({ ok: true, status });
}
