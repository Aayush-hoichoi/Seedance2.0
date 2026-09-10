// Is a presigned TOS GET URL past its life?
//
// A presign carries its own issue time (X-Tos-Date) and lifetime
// (X-Tos-Expires) in the query string, so the answer is local arithmetic — no
// request, no guessing. Signatures last 12h; the OBJECT behind them is
// permanent, which is what makes re-presigning from a stored tosKey always
// possible.
//
// This matters wherever a reference outlives its signature: a restored draft, a
// history "Reuse", a gallery handoff. Before this, an expired https TOS url was
// sent to ModelArk unchanged and failed the generation — only `asset://` refs
// were ever re-sourced.

// Renew a little early. A URL that dies between the pre-flight and the render
// is a failed generation, and the re-presign is local HMAC — cheap enough that
// buying five minutes of headroom costs nothing.
const DEFAULT_SKEW_SEC = 300;

export function tosPresignExpired(url, now = Date.now(), skewSec = DEFAULT_SKEW_SEC) {
    if (typeof url !== 'string' || !url) return false;
    try {
        const q = new URL(url).searchParams;
        const stamp = q.get('X-Tos-Date');       // 20260910T101530Z
        const lifetime = Number(q.get('X-Tos-Expires'));
        if (!stamp || !Number.isFinite(lifetime)) return false;
        const issued = Date.parse(
            `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`
            + `T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
        );
        if (!Number.isFinite(issued)) return false;
        return now > issued + (lifetime - skewSec) * 1000;
    } catch {
        // Not a presigned URL at all (asset://, a library pick, a plain CDN
        // link). Nothing to judge — and calling it expired would send a live
        // reference down the re-source path for no reason.
        return false;
    }
}
