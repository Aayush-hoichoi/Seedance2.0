// The project cast (Characters tab → tryon_characters) as a prompt-injection
// map. Descriptions written there reach every generation path the same way the
// console's style characters do: merged into the style's characters map just
// before composeStyledPrompt, which injects a CHARACTER LOCK only for the
// characters the prompt actually names.

/** { name: description } for every described, live cast member of a project. */
export async function projectCast(sql, projectId) {
    if (!sql || !projectId) return {};
    try {
        const rows = await sql`
            SELECT name, description FROM tryon_characters
            WHERE project_id = ${projectId} AND NOT deleted
              AND description IS NOT NULL AND description <> ''
            ORDER BY created_at DESC LIMIT 200`;
        const cast = {};
        for (const r of rows) if (!(r.name in cast)) cast[r.name] = r.description;
        return cast;
    } catch {
        return {}; // cast is an enhancement — never fail a generation over it
    }
}
