// How long a registered reference asset is allowed to sit in the shared
// BytePlus pool before a sweep reclaims it.
//
// The pool caps around 50 entries ACCOUNT-wide and assets are deliberately not
// deleted when a batch finishes (resolveMediaRefs reuses them across submits to
// stay off the 120 QPM write quota), so age sweeping is the only thing that
// returns capacity. One hour meant a busy afternoon kept the pool full and the
// next person's upload failed.
//
// The floor is set by in-flight work, not by taste: a submit sends `asset://id`
// and ModelArk resolves it while launchJob retries (~90s), so anything younger
// than a few minutes can still be pulled out from under a starting render. The
// quota-recovery escalation already treats 5 minutes as the safe floor; 10 is
// double that and still well clear of it.
//
// ponytail: age is the only signal — jobs don't record which assets they hold.
// If a render ever needs its reference past task creation, store the asset ids
// on the job and skip the ones a running job still references.
export const ASSET_TTL_MINUTES = 10;
export const ASSET_TTL_HOURS = ASSET_TTL_MINUTES / 60;
export const ASSET_TTL_MS = ASSET_TTL_MINUTES * 60 * 1000;
