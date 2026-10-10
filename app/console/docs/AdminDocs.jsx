'use client';

// Admin documentation: the governance rules behind the console — roles,
// access decisions, budget mechanics, queue limits and tool administration.
// Model facts render live from the ModelArk catalog, same as the user docs.

import { DocShell, DocSection, FactList, Callout } from '../../docs/DocShell.jsx';
import { VideoModelExplorer, ImageModelExplorer, ModeExplorer } from '../../docs/ModelReference.jsx';

const SECTIONS = [
    { id: 'roles', label: 'Roles & permissions' },
    { id: 'models', label: 'Model catalog' },
    { id: 'access', label: 'Access requests' },
    { id: 'budgets', label: 'Budgets & quotas' },
    { id: 'budget-requests', label: 'Budget requests' },
    { id: 'queue', label: 'Queue governance' },
    { id: 'tools', label: 'Tool administration' },
    { id: 'projects', label: 'Projects' },
    { id: 'workflows', label: 'Workflows' },
    { id: 'tabs', label: 'Console tabs' },
    { id: 'ops', label: 'Operations & retention' },
];

export default function AdminDocs() {
    return (
        <DocShell
            title="Admin Documentation"
            subtitle="How governance works: who can do what, how access and budget decisions are enforced, and the limits the gateway applies to every generation. Companion to the user docs at /docs."
            sections={SECTIONS}
        >
            <DocSection id="roles" title="Roles & permissions"
                lead="Roles are platform-wide (set in Users), not per project. Project membership only controls which projects a plain member can see.">
                <FactList items={[
                    ['Admin', 'Everything: projects, members, model grants, budgets, keys, usage, audit, ledger. Only admins decide access and budget requests, archive projects, and manage the console.'],
                    ['Manager', 'Members, budgets, usage, prompts. In the console they see exactly one tab: Projects (create/manage projects, members and budgets). Any other console URL redirects them there.'],
                    ['Member', 'Generate and view usage in their own projects. Default for everyone.'],
                    ['Reach', 'Admins and managers reach every project; members need a membership row.'],
                    ['Prompt visibility', 'Reading another user’s prompt text requires manager or above — enforced server-side.'],
                    ['Self-protection', 'An admin cannot change or delete their own account.'],
                ]} />
            </DocSection>

            <DocSection id="models" title="Model catalog"
                lead="The same live catalog users see, with gating and tier flags. Grant tiers form a ladder — a 1080p grant includes 720p and 480p; 4K is request-only platform-wide.">
                <VideoModelExplorer />
                <div className="mt-6"><ImageModelExplorer /></div>
                <div className="mt-6"><ModeExplorer /></div>
            </DocSection>

            <DocSection id="access" title="Access requests"
                lead="Decided in Console → Requests or Users. Approval writes a user-level allow override; revoke doubles as deny.">
                <FactList items={[
                    ['Expiry is mandatory', 'Every approval needs a future expiry (7d / 30d / 90d presets or a custom date). When a grant expires, the sweep revokes it, cancels in-flight jobs on it, and the user can re-request.'],
                    ['Tier on approval', 'You may grant a lower resolution tier than asked. A tier upgrade on an existing grant arrives as an "upgrade" request — denying it leaves the current grant untouched.'],
                    ['Precedence', 'User deny beats user allow, which beats a project grant, which beats org defaults; everything else is deny-by-default. Note: an allow with a tier cap beats an uncapped project grant — a capped user can end up more restricted than teammates.'],
                    ['Duplicates', 'A pending request absorbs repeats without re-pinging Slack/Teams. Approved-and-covered asks are no-ops.'],
                    ['Failure surfaced', 'If the decision saves but the enforcement write fails, the API answers 500 with a clear warning — the user still cannot use the model until retried.'],
                    ['Scope', 'Grants are enforced identically in studio, MCP and API — there is no separate permission model anywhere.'],
                ]} />
            </DocSection>

            <DocSection id="budgets" title="Budgets & quotas"
                lead="Budgets live in Console → Budgets and per-project in Projects. Enforcement is settled + reserved + estimate ≤ cap, checked in the reservation transaction itself.">
                <FactList items={[
                    ['Shapes', 'Types: usd, credits, image_count, video_seconds, request_count. Windows: daily, monthly, lifetime (UTC). Project budgets must be lifetime; a per-user budget must name a model (all-models user budgets are disabled).'],
                    ['Policies', 'hard = reject at the cap. soft = allow an overage of 1–50% (default 5%). Alert events fire at 80 / 90 / 100% of the cap, once each per window.'],
                    ['Wallet groups', 'Inside a project, a shared pool plus member wallets back each other: an over-cap wallet is forgiven while the other side still has room. The project overall cap is never forgiven, and a locked budget stops backing its group.'],
                    ['Locking', 'Lock stops all spending under a budget instantly, regardless of headroom; unlock resumes. On an uncapped model row, one click creates a budget frozen at today’s spend and locks it.'],
                    ['Carve-outs', 'Member budgets are carved out of the project overall budget — you can’t allocate more than the project cap holds, and the overall cap can’t drop below what’s already allocated or spent.'],
                    ['Edits', 'Top-ups are additive and safe under concurrent admins. Reducing a cap or narrowing scope requires a reason (3–500 chars), and a cap can never drop below spent + reserved. Deletes are soft and audited; per-budget history keeps the last 100 audit rows.'],
                ]} />
            </DocSection>

            <DocSection id="budget-requests" title="Budget requests"
                lead="Users ask from the studio; admins decide in Console → Requests → Budgets.">
                <FactList items={[
                    ['Shape', 'A request names a project, a model (or All models with a quality level: standard / high / maximum), an amount and a reason (≤ 500 chars).'],
                    ['Approval is an increment', 'The cap becomes max(current, already spent + reserved) + the approved amount. You may approve a different amount than asked — the adjustment is recorded.'],
                    ['Raise-only tiers', 'Approving a budget never lowers a resolution tier an admin granted — tier writes only ever raise.'],
                    ['Safety', 'Double decisions are impossible (advisory locks + guards — the second decider gets "already decided"). An approval that would overshoot the project overall cap is refused.'],
                ]} />
            </DocSection>

            <DocSection id="queue" title="Queue governance"
                lead="Console → Queue shows live jobs with cancel and per-project pause.">
                <FactList items={[
                    ['Limits', 'Queue depth 500 pending per project; concurrency 50 per project and 50 per model (set high on purpose — the BytePlus account quota is the real limiter).'],
                    ['Provider limits (official)', 'BytePlus caps Seedance 2.0 at 600 requests/min and 10 concurrent tasks per enterprise account for non-4K — but 4K is 15 requests/min and 1 concurrent task. Expect 4K jobs to serialize at the provider no matter what the gateway allows.'],
                    ['Ordering', 'Interactive before batch, then fairest project (fewest running), then oldest. Paused projects are skipped entirely.'],
                    ['Retries', 'Transient failures (429, 5xx, network) retry up to 3 times with 10s/40s/60s backoff; a job that never reached a provider gets one extra attempt. 4xx input/policy errors fail immediately. Timeouts: 30 min video, 5 min image.'],
                    ['Refusals are ledgered', 'Every refusal (pause, queue full, access, tier cap, quota) writes a rejected job row with the reason — nothing disappears silently.'],
                    ['Pause', 'Pausing a project refuses new submits and stalls queued jobs; resume releases them. Both are audited and emit live events.'],
                    ['Cancel', 'Admins and managers can cancel any job; the reservation is always released and in-flight provider work is cancelled best-effort.'],
                ]} />
            </DocSection>

            <DocSection id="tools" title="Tool administration"
                lead="Tools are catalog models (category tool) so they reuse the request flow and Budgets console unchanged.">
                <FactList items={[
                    ['Tool budgets', 'Upscale and EXR each need a tool-scoped budget (model = tool:upscale / tool:exr) — a broader project budget does not unlock them; nobody runs a tool unlimited. Try-On is the exception: it bills through the user’s normal image-model budgets, so access alone unlocks it.'],
                    ['EXR specifics', 'EXR access is its own request flow (Enhance Queue tab shows pending count). Admins bypass the access check but still need a tool:exr budget. Per-user limit: 3 active EXR jobs; duplicate sources are refused. Pro 4K is ~$16.53 per output minute at 24–30 fps, doubling at 60 and again at 120.'],
                    ['Upscale pricing', 'Priced per output minute by resolution, ×2 for standard, ×20 for professional, ×2 at 31–60 fps, ×4 at 61–120 fps. Jobs settle on the provider-reported duration, so an understated submit duration can’t lower the charge.'],
                    ['Tool billing', 'Tool jobs land in the same billing ledger as generations, under negative generation ids so the id spaces can never collide.'],
                ]} />
            </DocSection>

            <DocSection id="projects" title="Projects">
                <FactList items={[
                    ['Create', 'Admins and managers. Creating a name that matches an archived project revives it. Users can request a project by name (2–60 chars) — approval creates it with them as first member.'],
                    ['Archive', 'Admins only, soft-delete. Users with no active project see the empty state with an option to request one; managers can create one directly.'],
                    ['Members', 'Add/remove needs member.manage (admin + manager). Adding is idempotent; both are audited.'],
                    ['Project style', 'The style brief is validated before save (it rides on every generation), versions monotonically, and keeps full before/after history in the audit log.'],
                ]} />
            </DocSection>

            <DocSection id="workflows" title="Workflows">
                <FactList items={[
                    ['Access', 'One approved request unlocks the whole catalog for that user; admins bypass. Denying an access request also detaches the user’s attached workflow immediately.'],
                    ['Publishing', 'Custom workflows go public only with both sides: the owner requests, an admin approves (an admin publishing their own is both at once). Unpublishing detaches every other user.'],
                    ['Limits', 'Max 10 customs per user; name ≤ 80, description 10–2000, example prompt ≤ 5000 chars.'],
                    ['Nightly refresh', 'Styles self-improve from liked generations — only when at least 8 new liked samples exist, always as an audited version bump. The model can’t change enabled/sources/version fields.'],
                ]} />
            </DocSection>

            <DocSection id="tabs" title="Console tabs — quick reference">
                <FactList items={[
                    ['Dashboard', 'Workspace-wide spend and activity overview.'],
                    ['Projects', 'The one manager-visible tab: projects, members, budgets, grants, pause/archive.'],
                    ['Models', 'Catalog: alias → current version → provider routes, with month spend.'],
                    ['Workflows', 'Every workflow including private customs, with full style detail and visibility controls.'],
                    ['Queue / Enhance Queue', 'Live generation jobs; EXR/Upscale jobs and EXR access requests.'],
                    ['Ledger', 'The generation ledger in the exact workbook shape (41/45 columns), on screen and as download.'],
                    ['Usage', 'Any dimension × any window, chart + table + CSV.'],
                    ['Budgets', 'All budgets with usage, warnings, caps and policies.'],
                    ['Requests', 'Every request kind in one place: model access, budgets, projects, EXR, Try-On, workflows.'],
                    ['Issues', 'User-reported generation issues; Dismiss is the closing action.'],
                    ['Audit', 'The append-only audit trail behind every decision above.'],
                    ['Users', 'Grant/remove admin and manager, remove users, decide access requests with expiry + tier.'],
                ]} />
            </DocSection>

            <DocSection id="ops" title="Operations & retention">
                <Callout>
                    Prices shown in the catalog above are the live tables the gateway bills from; every billing event freezes the rate it used, so later price edits never rewrite history.
                </Callout>
                <FactList items={[
                    ['Cron', 'One daily cron (00:30 UTC): usage rollup for the last 2 days, queue sweep, reference-asset cleanup, Teams card backfill, EXR queue drain and workflow refresh. Day-to-day maintenance piggybacks on status polls, not cron.'],
                    ['Media retention', 'Generated media is kept indefinitely (no lifecycle rule), served only through 7-day presigned links — no object is public. The MuAPI /studio playground stores nothing in this bucket or the ledger.'],
                    ['Spend alerts', 'A WhatsApp alert fires each time total platform spend crosses a $500 milestone (configurable), exactly once per milestone.'],
                    ['Legacy grant cap', 'The deploy backfill capped all pre-existing grants at 2K/1080p — 4K has been request-only ever since.'],
                    ['Keys', 'Provider API keys are admin-only (key.manage).'],
                ]} />
            </DocSection>
        </DocShell>
    );
}
