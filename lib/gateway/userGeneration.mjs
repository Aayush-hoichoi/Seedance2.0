export async function isUserGenerationPaused(sql, userId) {
    const [row] = await sql`SELECT generation_paused FROM users
        WHERE id = ${userId} AND deleted_at IS NULL LIMIT 1`;
    return row?.generation_paused === true;
}
