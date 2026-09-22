// Project-scoped EXR capability requests. These rows share the existing
// access-request ledger but use a dedicated key so EXR does not become a
// model grant or a gateway override.

export const EXR_ACCESS_MODEL_ID = 'byteplus-exr';

function isLive(row) {
    return row?.status === 'approved'
        && (!row.expires_at || new Date(row.expires_at).getTime() > Date.now());
}

export function publicExrAccess(row, projectId = null) {
    const granted = isLive(row);
    const expired = row?.status === 'approved' && !granted;
    return {
        projectId: projectId ?? row?.project_id ?? null,
        requestId: row?.id ?? null,
        status: granted ? 'approved' : expired ? 'expired' : row?.status || 'locked',
        granted,
        expiresAt: granted ? row?.expires_at ?? null : null,
        requestedAt: row?.created_at ?? null,
        decidedAt: row?.decided_at ?? null,
    };
}

export async function getExrAccess(sql, { userId, projectId }) {
    const [row] = await sql`SELECT id, project_id, status, created_at, decided_at, expires_at
        FROM model_access_requests
        WHERE user_id = ${userId} AND model_id = ${EXR_ACCESS_MODEL_ID} AND project_id = ${projectId}
        LIMIT 1`;
    return publicExrAccess(row, projectId);
}

export async function requestExrAccess(sql, { userId, userEmail, projectId, note = null }) {
    const [existing] = await sql`SELECT id, project_id, status, created_at, decided_at, expires_at
        FROM model_access_requests
        WHERE user_id = ${userId} AND model_id = ${EXR_ACCESS_MODEL_ID} AND project_id = ${projectId}
        LIMIT 1`;
    const current = publicExrAccess(existing, projectId);
    if (current.granted || current.status === 'pending') return { ...current, fresh: false };
    const [row] = await sql`INSERT INTO model_access_requests
        (user_id, user_email, model_id, project_id, status, note, created_at)
        VALUES (${userId}, ${userEmail}, ${EXR_ACCESS_MODEL_ID}, ${projectId}, 'pending', ${note}, now())
        ON CONFLICT (user_id, model_id, project_id) DO UPDATE
        SET status = 'pending', user_email = ${userEmail}, note = ${note},
            created_at = now(), decided_by = NULL, decided_at = NULL, expires_at = NULL
        WHERE model_access_requests.status <> 'approved'
           OR (model_access_requests.expires_at IS NOT NULL AND model_access_requests.expires_at <= now())
        RETURNING id, project_id, status, created_at, decided_at, expires_at`;
    if (row) return { ...publicExrAccess(row, projectId), fresh: true };
    return { ...(await getExrAccess(sql, { userId, projectId })), fresh: false };
}

export async function listExrAccessRequests(sql) {
    return sql`SELECT r.id, r.user_id, r.user_email, r.project_id, p.name AS project_name,
            r.status, r.note, r.created_at, r.decided_by, r.decided_at, r.expires_at
        FROM model_access_requests r
        LEFT JOIN projects p ON p.id = r.project_id
        WHERE r.model_id = ${EXR_ACCESS_MODEL_ID}
        ORDER BY (r.status = 'pending') DESC, r.created_at DESC`;
}

export async function decideExrAccessRequest(sql, { id, status, decidedBy, expiresAt = null }) {
    const rows = await sql`UPDATE model_access_requests
        SET status = ${status}, decided_by = ${decidedBy}, decided_at = now(),
            expires_at = ${status === 'approved' ? expiresAt : null}
        WHERE id = ${id} AND model_id = ${EXR_ACCESS_MODEL_ID}
          AND status = 'pending'
        RETURNING id, user_id, user_email, project_id, status, created_at, decided_at, expires_at`;
    return rows[0] || null;
}

export async function exrProjectForUser(sql, user, requestedProjectId = null) {
    const projectId = Number(requestedProjectId);
    if (Number.isInteger(projectId) && projectId > 0) {
        if (user.role === 'admin') {
            const [project] = await sql`SELECT id FROM projects WHERE id = ${projectId} AND archived_at IS NULL`;
            return project?.id || null;
        }
        const [membership] = await sql`SELECT project_id FROM project_memberships
            WHERE project_id = ${projectId} AND user_id = ${user.userId}`;
        return membership?.project_id || null;
    }
    const [membership] = await sql`SELECT project_id FROM project_memberships
        WHERE user_id = ${user.userId} ORDER BY project_id LIMIT 1`;
    return membership?.project_id || null;
}
