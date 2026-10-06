'use client';

// User-facing documentation: every rule, limit and guideline a creator runs
// into, in one place. Model/mode facts render live from the ModelArk catalog
// (lib/seedance/constants.js) so this page can't drift from the studio.

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { DocShell, DocSection, FactList, Callout } from './DocShell.jsx';
import { VideoModelExplorer, ImageModelExplorer, ModeExplorer } from './ModelReference.jsx';

const SECTIONS = [
    { id: 'overview', label: 'How the studio works' },
    { id: 'video-models', label: 'Video models' },
    { id: 'image-models', label: 'Image models' },
    { id: 'modes', label: 'Generation modes' },
    { id: 'uploads', label: 'Upload limits' },
    { id: 'access', label: 'Getting access' },
    { id: 'budgets', label: 'Budgets & spending' },
    { id: 'queue', label: 'Queue & generations' },
    { id: 'tools', label: 'Tools' },
    { id: 'projects', label: 'Projects & sharing' },
    { id: 'workflows', label: 'Workflows' },
    { id: 'guidelines', label: 'Guidelines' },
];

export default function UserDocs() {
    return (
        <div className="min-h-screen w-full bg-app-bg text-ink">
            <div className="mx-auto max-w-6xl px-4 pt-6 sm:px-8">
                <Link href="/seedance" title="Back to studio" className="inline-grid h-7 w-7 place-items-center rounded-md border border-line bg-paper-2 text-ink-3 transition-colors hover:text-ink">
                    <ArrowLeft size={14} />
                </Link>
            </div>
            <DocShell
                title="Studio Documentation"
                subtitle="Everything the studio allows and enforces — models, modes, limits, access, budgets and tools. Pick a model or mode below to see its exact capabilities. All numbers on this page come straight from the studio's own configuration and the official provider documentation (BytePlus ModelArk, Google Gemini, OpenAI)."
                sections={SECTIONS}
            >
                <DocSection id="overview" title="How the studio works"
                    lead="You work inside a project. Every generation is priced before it runs, reserved against a budget, and settled at the real provider cost when it finishes.">
                    <FactList items={[
                        ['Entering', 'You need to be a member of at least one project. If you see only the projects page, ask an admin or manager to add you to a project.'],
                        ['One generation', 'Pick a mode, pick a model, set your options (ratio, resolution, duration), write a prompt, generate. The prompt bar shows the estimated cost before you click.'],
                        ['Billing', 'The estimate is reserved from your budget when the job starts. When it finishes, the reservation is replaced by the real cost from the provider. Failed jobs that reached the provider may still bill; cancelled and rejected jobs release the reservation.'],
                        ['Open by default', 'Seedance 2.0 Mini, Seedance 1.5 Pro (video) and Nano Banana 2 (image) work for everyone. Every other model needs an approved access request.'],
                        ['Results', 'Finished media lands in your gallery and in the shared community gallery. Download links are valid for 7 days at a time — the file itself is kept, a fresh link is minted whenever you come back.'],
                    ]} />
                </DocSection>

                <DocSection id="video-models" title="Video models"
                    lead="Select a model to see its access level, resolutions, duration range, supported modes and estimated cost.">
                    <VideoModelExplorer />
                </DocSection>

                <DocSection id="image-models" title="Image models"
                    lead="Select a model to see its access level, resolution tiers, reference-image cap and price per image.">
                    <ImageModelExplorer />
                </DocSection>

                <DocSection id="modes" title="Generation modes"
                    lead="Select a mode to see what it does and exactly which inputs it needs. Combine it with a model to check compatibility — reference-based modes only run on the Seedance 2.0/2.5 family.">
                    <ModeExplorer />
                </DocSection>

                <DocSection id="uploads" title="Upload & reference limits"
                    lead="What the studio accepts as reference material. Files outside these limits are rejected before any money is spent.">
                    <FactList items={[
                        ['Images', 'JPEG, PNG, WebP, BMP, TIFF, GIF, HEIC/HEIF. Max 30 MB each, 300–6000 px per side, aspect ratio between 0.4 and 2.5. Up to 9 reference images on Seedance 2.0, up to 30 on Seedance 2.5.'],
                        ['Videos', 'MP4 or MOV (H.264/H.265). Max 200 MB each, 300–6000 px per side, 24–60 fps (23.976 is fine). Seedance 2.0: each clip 2–15 s, 15 s combined, max 3 clips. Seedance 2.5: each clip up to 30 s, 30 s combined, max 10 clips.'],
                        ['Audio', 'WAV or MP3, max 15 MB. Seedance 2.0: 2–15 s each, 15 s combined, max 3 files, and audio can’t be used alone. Seedance 2.5: up to 30 s combined, max 10 files, audio alone is allowed.'],
                        ['Whole request', 'One generation request can carry at most 64 MB in total. For big files, use library assets instead of re-uploading.'],
                        ['Image prompts', 'Prompt text is required for image models, up to 5000 characters. Inline reference images are capped at 4 MB total — that’s why ChatGPT Image models take 8 references here even though the provider advertises more.'],
                        ['Batch size', 'Image generations run 1–4 images per request.'],
                    ]} />
                </DocSection>

                <DocSection id="access" title="Getting access to gated models"
                    lead="Premium models and tools are on request. The lock icon in the model picker starts the flow.">
                    <FactList items={[
                        ['Requesting', 'Pick the locked model, add an optional note (up to 500 characters) and send. Requests are per project. For tools (Upscale, EXR, Try-On) a note of at least 10 characters is required.'],
                        ['Quality tier', 'You can ask for a maximum resolution (e.g. 1080p or 4K). The admin may grant your ask, or a lower tier. A grant at one tier includes every tier below it. 4K is always request-only.'],
                        ['While pending', 'Sending the same request twice doesn’t re-ping anyone — the first one stands. An admin sees it in Console → Requests.'],
                        ['Approval', 'Every approval has an expiry date (admins typically pick 7, 30 or 90 days). When it expires, the model locks again and any running jobs on it are cancelled — just request again.'],
                        ['Denial', 'A denied or revoked request can be sent again later.'],
                        ['Where access applies', 'A grant works everywhere you are signed in: the studio, the MCP connector and the API all enforce the exact same permissions.'],
                    ]} />
                </DocSection>

                <DocSection id="budgets" title="Budgets & spending"
                    lead="Every dollar is governed by budgets that admins set per project, per member and per model.">
                    <FactList items={[
                        ['Checking before running', 'Before a job runs, the studio checks: money already spent + money reserved by running jobs + this job’s estimate must fit under every budget that applies to you.'],
                        ['When you hit the cap', 'The job is refused with a clear message (nothing is charged) and shows up in the ledger as rejected. Hard budgets stop exactly at the cap; soft budgets allow a small overage (usually 5%).'],
                        ['Locked budgets', 'An admin can lock a budget — then every request under it is refused regardless of remaining money, until it’s unlocked.'],
                        ['Asking for more', 'Use the "Request budget" button in the studio. Pick a model (or All models), an amount (minimum $0.01) and a reason (up to 500 characters). An admin can approve the full amount, a different amount, or deny with a note.'],
                        ['Auto duration costs more', 'With duration on "Auto" the cost is reserved at the model’s maximum length (30 s on Seedance 2.5, 15 s elsewhere), because the model decides the real length. The final charge settles at the actual output.'],
                        ['Estimates vs final', 'Video estimates are forecasts — the final cost comes from the provider’s token count and can differ (attaching a video typically adds ~17%). Image prices are exact.'],
                        ['Your spend', 'The spend chip in the studio header shows where you stand. It turns orange under 15% remaining and red under 5%.'],
                    ]} />
                </DocSection>

                <DocSection id="queue" title="Queue & generations"
                    lead="What happens between clicking Generate and getting your video.">
                    <FactList items={[
                        ['Queue cap', 'A project can hold up to 500 pending generations. Interactive jobs run before batch jobs, and projects are balanced fairly.'],
                        ['Waiting time', 'The studio polls your job for up to ~15 minutes. Long renders keep running server-side even if you close the tab — results land in your gallery.'],
                        ['Retries', 'Transient provider errors (rate limits, outages) retry automatically up to 3 times with backoff. Bad input or content-policy rejections fail immediately — fix the input and resubmit.'],
                        ['Cancelling', 'You can cancel your own queued or running generation; a manager or admin can cancel anyone’s. Cancelling frees the reserved budget.'],
                        ['Sensitive content', 'If a legitimate production shot (e.g. drama scenes) keeps failing moderation, the "Sensitive Content" model is the same Seedance 2.0 engine behind a more permissive endpoint — it needs its own access request.'],
                        ['Reporting problems', 'Use the issue-report button on a bad generation; notes up to 500 characters. Admins review these in the console.'],
                    ]} />
                </DocSection>

                <DocSection id="tools" title="Tools"
                    lead="Post-production tools live under Tools in the header. Each needs its own access request, and Upscale/EXR also need a tool budget from an admin.">
                    <FactList items={[
                        ['Video Upscale', 'Input up to 2K (long side ≤ 2560 px), containers mp4/flv/ts/avi/mov/wmv/mkv, source up to 6 hours. Output 240p–8K, 15–120 fps. Standard version is ~6–10 min of processing per video minute; Professional is 25–60 min and 10× the price (and unlocks pro codecs like ProRes and 16-bit). 16-bit output needs a source ≤ 40 s.'],
                        ['EXR Output', 'Separate access request. Tiers fast/standard/pro, output 720p–8K EXR at 24/30/60/120 fps, 16-bit only. Source up to 6 hours. Max 3 EXR jobs running at once per user, and the same video can’t be queued twice. Pro 4K costs ~$16.53 per output minute at 24–30 fps — it doubles at 60 fps and again at 120.'],
                        ['Try-On', 'Image only — drop a character image and wardrobe/prop images and merge them. Each merge is a normal image generation billed to your model budgets (no separate tool budget). Project members share the cast, wardrobe and history; only the creator (or an admin) can delete entries.'],
                        ['Compare', 'Play 2 or 4 takes side by side, frame-stepped at 24 fps. Fully local in your browser — nothing is uploaded, no access needed.'],
                    ]} />
                </DocSection>

                <DocSection id="projects" title="Projects & sharing"
                    lead="Projects are the workspace unit — membership, budgets and access requests all hang off them.">
                    <FactList items={[
                        ['Membership', 'Admins and managers see every project; you see the ones you belong to. Need a new project? Request one by name (2–60 characters) — an admin or manager approves and you become its first member.'],
                        ['Paused projects', 'An admin can pause a project: new generations are refused and queued ones wait until it’s resumed.'],
                        ['Gallery', 'Every signed-in user can browse every creator’s finished work in the community gallery. Liking a video helps train the workflow styles.'],
                        ['Prompts stay private-ish', 'Other members can see your generations, but reading your prompt text requires manager rights.'],
                        ['Project style', 'A project can carry a style brief that’s automatically appended to every generation in it. Admins manage it; versions are kept.'],
                    ]} />
                </DocSection>

                <DocSection id="workflows" title="Workflows"
                    lead="Workflows are reusable style engines you attach to your account — every generation you make then goes through that style.">
                    <FactList items={[
                        ['Access', 'One approved request unlocks the whole workflow catalog. Request from the workflow picker; denied requests can be re-asked.'],
                        ['Attaching', 'You can attach one video workflow and one image workflow at a time. The attachment follows your account — studio, MCP and API alike.'],
                        ['Custom workflows', 'You can create up to 10 of your own. Name up to 80 characters, description 10–2000 characters, example prompt up to 5000. They start private; publishing to everyone needs an admin’s approval.'],
                        ['Self-improving', 'Workflows refresh themselves nightly from generations people liked (needs at least 8 new liked samples). Every change is versioned and audited.'],
                        ['Priority', 'If you attach a workflow, it overrides the project style. If the workflow is deleted or unpublished, you fall back to the project style automatically.'],
                    ]} />
                </DocSection>

                <DocSection id="guidelines" title="Guidelines & good practice">
                    <Callout>
                        The short version: start on the open models (Mini / Nano Banana 2) to iterate cheaply, switch to a premium tier for finals, keep duration explicit when you can (Auto reserves the maximum), and like the results you’d want more of — likes feed the workflow styles.
                    </Callout>
                    <FactList items={[
                        ['Prompting', 'Up to 5000 characters. The styled modes (Motion Capture, Green Screen, Performance Transfer, Mannequin, Customized) rewrite your prompt into a strict production brief automatically — describe what should change, the enhancer handles structure.'],
                        ['Ratios', 'On Seedance 2.5, video edits and first-frame tasks always inherit the input’s aspect ratio — the ratio picker is ignored for those. Pick "adaptive" when unsure.'],
                        ['Keep sources clean', 'Green-screen modes want a real green-screen plate. Reference videos must be 24–60 fps and inside the size limits above — the studio checks before spending.'],
                        ['Downloads', 'Download links expire after 7 days but the media is kept — revisit the gallery for a fresh link. The MuAPI-based /studio playground is separate: its output is not archived here.'],
                        ['Watermark', 'Off by default. It’s a per-generation Seedance option and doesn’t change the price.'],
                    ]} />
                </DocSection>
            </DocShell>
        </div>
    );
}
