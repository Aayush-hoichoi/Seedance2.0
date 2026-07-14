import { NextResponse } from 'next/server';
import { gatewayContext, clientIp } from '../../../../../lib/gateway/authz.js';
import { apiError } from '../../../../../lib/gateway/httpError.mjs';
import { writeAudit } from '../../../../../lib/gateway/db.js';

export const runtime = 'nodejs';

// Toggle a model's org-default flag (models.is_default). Platform-admin only —
// this flips whether the model is granted to everyone by default (the "org
// default" rung of the access precedence), so it's not a manager action.
export async function PATCH(request, { params }) {
    const { id } = await params;
    const auth = await gatewayContext({});
    if (!auth.ok) return auth.response;
    const { sql, user, isPlatformAdmin } = auth.ctx;
    if (!isPlatformAdmin) return apiError('FORBIDDEN', 'Only admins can change org defaults.');

    const body = await request.json().catch(() => null);
    if (typeof body?.isDefault !== 'boolean') {
        return apiError('BAD_REQUEST', 'isDefault (boolean) is required.');
    }
    const [before] = await sql`SELECT id, is_default FROM models WHERE id = ${id}`;
    if (!before) return apiError('NOT_FOUND', 'Model not found.');

    const [row] = await sql`UPDATE models SET is_default = ${body.isDefault} WHERE id = ${id}
        RETURNING id, is_default`;
    await writeAudit(sql, {
        actorId: user.userId, actorEmail: user.email,
        action: body.isDefault ? 'model.set_default' : 'model.unset_default',
        targetType: 'model', targetId: id,
        before: { is_default: before.is_default }, after: { is_default: row.is_default },
        ip: clientIp(request),
    });
    return NextResponse.json(row);
}
