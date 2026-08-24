// Live probe of the kie.ai adapter — run this BEFORE trusting the capability
// claims baked into constants.js. Seedance 2.5 once shipped resolution support
// "by analogy" and users hit the provider's rejection at submit time, after the
// job had been priced; this repo verifies tiers against the real API instead.
//
// It exercises the adapter itself (not a hand-written curl), so what passes here
// is exactly what the queue will do.
//
//   node --env-file=.env.local scripts/kie-smoke.mjs
//   node --env-file=.env.local scripts/kie-smoke.mjs --image ./ref.png
//   node --env-file=.env.local scripts/kie-smoke.mjs --tier 4K --ratio 16:9
//
// Costs: each successful generation bills the account (~$0.03–$0.08). The
// rejection probe costs nothing — a task kie refuses to create is never billed.

import { readFileSync } from 'node:fs';
import * as kie from '../lib/gateway/providers/kie.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const apiKey = process.env.KIE_API_KEY?.trim();
if (!apiKey) { console.error('Set KIE_API_KEY in .env.local first.'); process.exit(1); }

const route = { provider_model_id: process.env.KIE_GPT_IMAGE_2_MODEL_ID || 'gpt-image-2-text-to-image' };
const ratio = flag('ratio', '16:9');
const tier = flag('tier', '2K');
const imagePath = flag('image');

// Mirrors what enqueue.mjs persists: prompt + optional Gemini-shaped ref parts,
// with the studio's options under `options`.
function fakeJob({ prompt, parts = null, options }) {
    return { id: `smoke-${Date.now()}`, model_id: 'chatgpt-image-2', request_body: { prompt, ...(parts ? { parts } : {}), options } };
}

async function run(label, job) {
    process.stdout.write(`\n▸ ${label}\n`);
    const submitted = await kie.submit({ job, route, apiKey });
    if (!submitted.ok) { console.log('  submit failed:', JSON.stringify(submitted.error)); return null; }
    console.log('  taskId:', submitted.providerTaskId);

    const polled = { ...job, provider_task_id: submitted.providerTaskId };
    const deadline = Date.now() + 15 * 60_000; // kie: give up after 10–15 min
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3_000));
        const p = await kie.poll({ job: polled, apiKey });
        if (!p.ok) { console.log('  poll error:', JSON.stringify(p.error)); return null; }
        if (!p.done) { process.stdout.write(`  ${p.status}…\n`); continue; }
        if (p.status !== 'succeeded') { console.log('  FAILED:', JSON.stringify(p.error)); return null; }
        const img = p.result.images[0];
        // b64 means the bytes were pulled off kie's expiring URL, which is what
        // storeImages() needs to persist the image to our own bucket.
        console.log(`  OK — ${p.result.images.length} image(s), ${img.b64 ? `${Math.round(img.b64.length / 1365)}KB inline` : `URL ONLY: ${img.url}`}`);
        return p.result;
    }
    console.log('  timed out after 15 min');
    return null;
}

// 1. Text to image at the requested ratio/tier.
await run(`text-to-image · ${ratio} · ${tier}`, fakeJob({
    prompt: 'A lighthouse on a rocky coast at dusk, long exposure, moody sky.',
    options: { aspectRatio: ratio, imageSize: tier },
}));

// 2. Image to image, only when a reference is supplied: this walks the full
//    base64 → kie file-upload → input_urls path, the part most likely to break.
if (imagePath) {
    const b64 = readFileSync(imagePath).toString('base64');
    const mimeType = imagePath.endsWith('.jpg') || imagePath.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    await run(`image-to-image · ${ratio} · ${tier} · ref ${imagePath}`, fakeJob({
        prompt: 'Place this subject in a bright modern studio, soft key light, editorial look.',
        parts: [{ text: 'ref' }, { inlineData: { mimeType, data: b64 } }],
        options: { aspectRatio: ratio, imageSize: tier },
    }));
} else {
    console.log('\n▸ image-to-image · skipped (pass --image <path> to exercise the reference upload)');
}

// 3. The one ratio restriction that survived live probing: 5:4 (and 4:5) are
//    capped at 1K. The adapter clamps, so this asks the API directly, bypassing
//    the clamp. Free either way — a task kie refuses to create is never billed.
//    kie called the restriction "temporary", so re-run this occasionally: if it
//    starts SUCCEEDING, drop the ratio from GPT_IMAGE_2_1K_ONLY_RATIOS.
//    (The docs' two other claims — 1:1 capped at 2K, and unspecified-ratio
//    capped at 1K — were both false on 2026-08-22: each delivered 2880×2880.)
process.stdout.write('\n▸ probe: 5:4 @ 4K (expected to be rejected by kie)\n');
const probe = await fetch(`${process.env.KIE_API_BASE?.trim() || 'https://api.kie.ai'}/api/v1/jobs/createTask`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: route.provider_model_id, input: { prompt: 'a red cube', aspect_ratio: '5:4', resolution: '4K' } }),
});
const probeBody = await probe.json().catch(() => null);
console.log(`  HTTP ${probe.status} · code ${probeBody?.code} · ${probeBody?.msg || ''}`);
console.log(probeBody?.code === 200
    ? '  NOTE: kie now ACCEPTS 5:4 @ 4K — drop it from GPT_IMAGE_2_1K_ONLY_RATIOS in lib/seedance/constants.js.'
    : '  Rejected, as it was when the rule was probed — the clamp is earning its keep.');

process.exit(0);
