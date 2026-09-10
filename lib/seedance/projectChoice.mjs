// Which project this browser is in — the ONE place that answers it.
//
// Two callers need the same answer at different moments: the bootstrap, once
// /api/projects says which projects exist, and the draft restore at mount,
// which cannot wait for that round trip and must guess. Both resolve it the
// same way — a ?project= deep-link beats the last stored choice — and when
// they disagree the studio restores one project's draft while showing another.
// So the precedence lives here once, and the key string exists once.

export const PROJECT_KEY = 'seedance:project';

// The stored/linked choice, with no knowledge of what actually exists. Used at
// mount, before the project list has landed.
export function preferredProjectId(search = '', storage = null) {
    const read = () => {
        try {
            return Number(storage?.getItem(PROJECT_KEY)) || null;
        } catch {
            return null; // private mode / storage blocked
        }
    };
    let fromUrl = null;
    try {
        fromUrl = Number(new URLSearchParams(search).get('project')) || null;
    } catch {
        fromUrl = null;
    }
    return fromUrl ?? read();
}

// The same precedence, now narrowed to projects the user actually has. Falls
// back to the first granted project — a stored id can name a project since
// revoked, and landing nowhere would be worse than landing somewhere real.
export function resolveProjectId(items, search = '', storage = null) {
    if (!Array.isArray(items) || !items.length) return null;
    const wanted = preferredProjectId(search, storage);
    return items.some((p) => p.id === wanted) ? wanted : items[0].id;
}

export function rememberProjectId(id, storage = null) {
    try {
        storage?.setItem(PROJECT_KEY, String(id));
    } catch {
        // Private mode: the choice just won't survive the next reload.
    }
}
