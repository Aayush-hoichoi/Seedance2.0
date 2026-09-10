// The prompt bar's DRAFT — the prompt text and the attached references —
// remembered across a reload, PER PROJECT.
//
// Its sibling settingsMemory.mjs keeps the pills (mode, model, ratio,
// resolution, duration, seed, toggles); this keeps what the user actually
// typed and attached. Two files, two localStorage keys, on purpose: image
// references are inline base64 and can approach the origin's whole storage
// budget, and a quota failure here must never cost the settings, which fit in
// a few hundred bytes and have always survived a reload.
//
// Per project because projects are a hard boundary everywhere else in the
// studio — assets, budgets and model grants are all project-scoped, and a
// reference registered under project A is not resolvable from project B. One
// shared draft would carry a prompt across that line.
//
// pack/merge/unpack are pure and dependency-injected (the mode catalog is
// passed in, not imported) so they stay unit-testable under `node --test`;
// load/save are the localStorage half and no-op on the server.

const KEY = 'seedance.draft.v1';

// Bumping this retires every stored draft (an entry of another version is
// ignored outright, never half-applied).
export const DRAFT_VERSION = 1;

// Total base64 kept across a project's image references. Nano Banana Pro takes
// 14 refs at ~250KB of base64 each — well past the ~5MB localStorage budget
// this shares with the job history — so the refs that fit are kept and the
// rest are dropped rather than losing the whole draft to a quota throw.
const IMAGE_REF_BUDGET = 2_000_000;

// Drafts are a convenience, not an archive: only recent work in a handful of
// projects is worth the space.
const MAX_PROJECTS = 8;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const projectKey = (projectId) => String(projectId ?? 'none');

/* ── pack ───────────────────────────────────────────────────────────────── */

// Snapshot the live bar into a storable entry, or null when there is nothing
// worth remembering (an empty prompt and no references).
export function packDraft({ prompt = '', mediaByRole = {}, imageRefs = [], now = Date.now() } = {}) {
    const refs = [];
    for (const [role, items] of Object.entries(mediaByRole || {})) {
        for (const m of items || []) {
            // A still-uploading placeholder has no URL yet, and a data: URL is
            // a local blob that nothing can re-source once the tab closes.
            if (!m || m.pending) continue;
            if (typeof m.url !== 'string' || !m.url || m.url.startsWith('data:')) continue;
            refs.push({
                kind: m.kind,
                role,
                url: m.url,
                previewUrl: typeof m.previewUrl === 'string' && !m.previewUrl.startsWith('data:') ? m.previewUrl : null,
                name: m.name || null,
                assetId: m.assetId || null,
                tosKey: m.tosKey || null,
                fromLibrary: !!m.fromLibrary,
            });
        }
    }

    // Image references are the only heavy thing here. `previewUrl` is the same
    // bytes over again as a data: URL, so it is dropped and rebuilt on restore.
    const keptImages = [];
    let bytes = 0;
    for (const r of imageRefs || []) {
        if (typeof r?.b64 !== 'string' || typeof r?.mimeType !== 'string') continue;
        if (bytes + r.b64.length > IMAGE_REF_BUDGET) break;
        bytes += r.b64.length;
        keptImages.push({ mimeType: r.mimeType, b64: r.b64, name: r.name || null });
    }

    const text = typeof prompt === 'string' ? prompt : '';
    if (!text.trim() && !refs.length && !keptImages.length) return null;
    return { prompt: text, refs, imageRefs: keptImages, at: now };
}

/* ── merge ──────────────────────────────────────────────────────────────── */

// Fold one project's entry into the stored map and return a NEW map — a null
// entry removes that project's draft. Stale and surplus projects are pruned
// here so the map can't grow without bound.
export function mergeDraft(stored, projectId, entry, now = Date.now()) {
    const prev = stored && stored.v === DRAFT_VERSION && stored.byProject && typeof stored.byProject === 'object'
        ? stored.byProject
        : {};
    const next = { ...prev };
    if (entry) next[projectKey(projectId)] = entry;
    else delete next[projectKey(projectId)];

    const live = Object.entries(next)
        .filter(([, e]) => e && typeof e === 'object' && now - (e.at || 0) < MAX_AGE_MS)
        .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
        .slice(0, MAX_PROJECTS);
    return { v: DRAFT_VERSION, byProject: Object.fromEntries(live) };
}

/* ── unpack ─────────────────────────────────────────────────────────────── */

// Validate a project's stored entry against the LIVE mode and return the state
// to apply, or null when there is nothing to restore. References are matched
// to the mode's slots exactly as a history "Reuse" does: a ref whose slot no
// longer exists (the mode changed under the draft) is dropped on its own, and
// never costs the prompt or the refs that still fit.
export function unpackDraft(raw, projectId, { mode = null, imageRefMax = 0 } = {}) {
    if (!raw || typeof raw !== 'object' || raw.v !== DRAFT_VERSION) return null;
    const entry = raw.byProject && typeof raw.byProject === 'object' ? raw.byProject[projectKey(projectId)] : null;
    if (!entry || typeof entry !== 'object') return null;

    const mediaByRole = {};
    for (const r of Array.isArray(entry.refs) ? entry.refs : []) {
        if (!r?.url) continue;
        const slot = mode?.media?.find((s) => s.role === r.role && s.kind === r.kind);
        if (!slot) continue;
        const arr = mediaByRole[r.role] || (mediaByRole[r.role] = []);
        if (arr.length >= slot.max) continue;
        arr.push({
            kind: r.kind,
            role: r.role,
            url: r.url,
            previewUrl: r.previewUrl || null,
            name: r.name || '',
            isImage: r.kind === 'image',
            assetId: r.assetId || null,
            // Lets a stale asset:// link be re-sourced at submit, same as Reuse.
            tosKey: r.tosKey || null,
            fromLibrary: !!r.fromLibrary,
        });
    }

    // The per-model cap is the live one: a draft saved on Pro (14 refs) must
    // not overfill the bar after the settings restore lands on Flash (3).
    const imageRefs = (Array.isArray(entry.imageRefs) ? entry.imageRefs : [])
        .filter((r) => typeof r?.b64 === 'string' && typeof r?.mimeType === 'string')
        .slice(0, imageRefMax)
        .map((r) => ({
            name: r.name || '',
            mimeType: r.mimeType,
            b64: r.b64,
            previewUrl: `data:${r.mimeType};base64,${r.b64}`,
        }));

    const prompt = typeof entry.prompt === 'string' ? entry.prompt : '';
    if (!prompt && !Object.keys(mediaByRole).length && !imageRefs.length) return null;
    return { prompt, mediaByRole, imageRefs };
}

/* ── storage (browser only; a failure costs the draft, never the session) ── */

export function loadDraft() {
    if (typeof window === 'undefined') return null;
    try {
        const raw = window.localStorage.getItem(KEY);
        const obj = raw ? JSON.parse(raw) : null;
        return obj && typeof obj === 'object' ? obj : null;
    } catch {
        return null;
    }
}

// Returns true when the draft is stored, false when the browser refused it.
// The caller needs the answer: a draft that silently stops persisting looks
// exactly like one that is being saved, and the user keeps typing into it.
export function saveDraft(map, projectId) {
    if (typeof window === 'undefined' || !map) return true; // server: nothing to promise
    try {
        window.localStorage.setItem(KEY, JSON.stringify(map));
        return true;
    } catch {
        // Over quota — several projects' image references at once.
    }
    // The draft being typed in right now beats the ones the user has left
    // behind, so drop the others rather than lose it.
    try {
        const mine = map.byProject?.[projectKey(projectId)];
        window.localStorage.setItem(KEY, JSON.stringify(
            mine ? { v: DRAFT_VERSION, byProject: { [projectKey(projectId)]: mine } } : { v: DRAFT_VERSION, byProject: {} },
        ));
        return true;
    } catch {
        // Even alone it doesn't fit (one huge set of inline refs), or storage is
        // blocked entirely. Say so rather than let the bar imply it is safe.
        return false;
    }
}
