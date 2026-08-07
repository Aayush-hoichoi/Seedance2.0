// Pure mirror of /api/events audience rules. User-targeted events are private:
// a project id provides context but must not widen a personal event to every
// member. Untargeted events remain project- or workspace-wide broadcasts.
export function eventVisibleTo({ event, isAdmin = false, userId = null, projectIds = [] }) {
    if (isAdmin) return true;
    if (event?.user_id != null) return event.user_id === userId;
    if (event?.project_id == null) return true;
    return projectIds.includes(event.project_id);
}

export async function visibleEvents(sql, { cursor, isAdmin, projectIds, userId }) {
    return sql.query(
        `SELECT * FROM events
         WHERE id > $1
           AND ($2
             OR (user_id IS NOT NULL AND user_id = $4)
             OR (user_id IS NULL AND (project_id IS NULL OR project_id = ANY($3::int[]))))
         ORDER BY id ASC LIMIT 100`,
        [cursor, isAdmin, projectIds, userId],
    );
}
