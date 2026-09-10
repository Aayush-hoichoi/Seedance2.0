// Which project this browser is in — the ONE place that answers it.
//
// Two callers need the same answer at different moments: the bootstrap, once
// /api/projects says which projects exist, and the draft restore at mount,
// which cannot wait for that round trip and must guess. Both resolve it the
// same way — a ?project= deep-link beats the last stored choice — and when
// they disagree the studio restores one project's draft while showing another.
// So the precedence lives here once, and the key string exists once.

export const PROJECT_KEY = 'seedance:project';
export const PROJECT_PARAM = 'project';

function urlProjectId(search) {
    try {
        return Number(new URLSearchParams(search).get(PROJECT_PARAM)) || null;
    } catch {
        return null;
    }
}

function storedProjectId(storage) {
    try {
        return Number(storage?.getItem(PROJECT_KEY)) || null;
    } catch {
        return null; // private mode / storage blocked
    }
}

// Candidates in precedence order: a /projects deep-link, then the last choice
// this browser stored.
function candidates(search, storage) {
    return [urlProjectId(search), storedProjectId(storage)].filter(Boolean);
}

// The best guess with no knowledge of what exists. Used at mount, before the
// project list has landed — it may name a project the user cannot open, which
// resolveProjectId corrects once the list arrives.
export function preferredProjectId(search = '', storage = null) {
    return candidates(search, storage)[0] ?? null;
}

// The first candidate the user ACTUALLY has — not the first candidate, then
// validated. A stale ?project= naming a project since revoked must fall through
// to the stored choice rather than discard it and land on someone's first
// project. Only when neither candidate survives is the first granted project
// used: landing nowhere would be worse than landing somewhere real.
export function resolveProjectId(items, search = '', storage = null) {
    if (!Array.isArray(items) || !items.length) return null;
    const found = candidates(search, storage).find((id) => items.some((p) => p.id === id));
    return found ?? items[0].id;
}

// A ?project= outlives the choice it described: /projects opens
// /seedance?project=8, the user switches to another project in the studio, and
// every reload from then on reads the stale param and drags them back. Once
// they choose in the studio, make the URL say what they chose. Only rewrites a
// param that is already there — an absent one is not noise worth adding, and
// the stored choice governs that case correctly on its own.
export function syncProjectParam(id, loc = null, hist = null) {
    if (!id || !loc?.href || typeof hist?.replaceState !== 'function') return null;
    try {
        const url = new URL(loc.href);
        if (url.searchParams.get(PROJECT_PARAM) === String(id)) return null; // already agrees
        if (!url.searchParams.has(PROJECT_PARAM)) return null;               // nothing to correct
        url.searchParams.set(PROJECT_PARAM, String(id));
        hist.replaceState(hist.state, '', url.toString()); // replace: no history entry per switch
        return url.toString();
    } catch {
        return null; // never let a URL rewrite break selecting a project
    }
}

export function rememberProjectId(id, storage = null) {
    try {
        storage?.setItem(PROJECT_KEY, String(id));
    } catch {
        // Private mode: the choice just won't survive the next reload.
    }
}
