import { NextResponse } from 'next/server';
import { gatewayContext, clientIp } from '../../../../lib/gateway/authz.js';
import { apiError } from '../../../../lib/gateway/httpError.mjs';
import { writeAudit } from '../../../../lib/gateway/db.js';
import { encryptSecret, decryptSecret, keyLast4 } from '../../../../lib/gateway/keybox.mjs';

export const runtime = 'nodejs';

// Provider API keys: encrypted at rest, never returned — list shows label +
// last4 only. Rotation: POST new key (old auto-marked retiring), PATCH retire.

export async function GET() {
    const auth = await gatewayContext({ permission: 'key.manage' });
    if (!auth.ok) return auth.response;
    const { sql } = auth.ctx;
    const rows = await sql`SELECT id, provider_id, scope_org_id, scope_project_id, ciphertext, label, status, created_at
        FROM api_keys WHERE status != 'deleted' ORDER BY created_at DESC`;
    const items = rows.map(({ ciphertext, ...row }) => ({ ...row, last4: keyLast4(decryptSecret(ciphertext) || '') }));
    return NextResponse.json({ items });
}

export async function POST(request) {
    const auth = await gatewayContext({ permission: 'key.manage' });
    if (!auth.ok) return auth.response;
    const { sql, user, org } = auth.ctx;
    if (!process.env.KEY_ENCRYPTION_KEY) {
        return apiError('BAD_REQUEST', 'Set KEY_ENCRYPTION_KEY in the environment before storing provider keys.');
    }
    const b = await request.json().catch(() => null);
    if (!b?.providerId || !b?.key?.trim()) return apiError('BAD_REQUEST', 'providerId and key are required.');

    // Rotation: previous active keys for the same scope move to 'retiring'.
    await sql`UPDATE api_keys SET status = 'retiring'
        WHERE provider_id = ${b.providerId} AND status = 'active'
          AND scope_project_id IS NOT DISTINCT FROM ${b.projectId ?? null}`;
    const [row] = await sql`INSERT INTO api_keys (provider_id, scope_org_id, scope_project_id, ciphertext, label, created_by)
        VALUES (${b.providerId}, ${org.id}, ${b.projectId ?? null}, ${encryptSecret(b.key.trim())}, ${b.label ?? null}, ${user.userId})
        RETURNING id, provider_id, label, status, created_at`;
    await writeAudit(sql, {
        actorId: user.userId, actorEmail: user.email, action: 'key.create',
        targetType: 'api_key', targetId: row.id, after: { providerId: b.providerId, label: b.label ?? null }, ip: clientIp(request),
    });
    return NextResponse.json(row, { status: 201 });
}

export async function PATCH(request) {
    const auth = await gatewayContext({ permission: 'key.manage' });
    if (!auth.ok) return auth.response;
    const { sql, user } = auth.ctx;
    const b = await request.json().catch(() => null);
    if (!b?.id || !['retiring', 'deleted', 'active'].includes(b?.status)) {
        return apiError('BAD_REQUEST', 'id and status (active|retiring|deleted) required.');
    }
    const [row] = await sql`UPDATE api_keys SET status = ${b.status} WHERE id = ${b.id} RETURNING id, provider_id, label, status`;
    if (!row) return apiError('NOT_FOUND', 'Key not found.');
    await writeAudit(sql, {
        actorId: user.userId, actorEmail: user.email, action: `key.${b.status === 'deleted' ? 'delete' : b.status}`,
        targetType: 'api_key', targetId: row.id, ip: clientIp(request),
    });
    return NextResponse.json(row);
}
