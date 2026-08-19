// BytePlus ModelArk Seedance 2.0 — option catalog and mode definitions.
// Model IDs carry a date suffix and can be deprecated/rotated by BytePlus.
// When that happens, override via .env.local WITHOUT a code edit:
//   NEXT_PUBLIC_SEEDANCE_MODEL_ID=dreamina-seedance-2-0-<newdate>   (or an ep-xxxx endpoint)
//   NEXT_PUBLIC_SEEDANCE_FAST_MODEL_ID=dreamina-seedance-2-0-fast-<newdate>
//   NEXT_PUBLIC_SEEDANCE_MINI_MODEL_ID=dreamina-seedance-2-0-mini-<newdate>
//   NEXT_PUBLIC_SEEDANCE_2_5_MODEL_ID=dreamina-seedance-2-5-<date>   (REQUIRED before activating 2.5)
// The hardcoded values below are the known-good defaults used when the env vars are unset.

// Seedance 2.5 — activated on ModelArk 2026-08-13, id read back from the live
// GET /api/v3/models listing (status normal, task_type MultimodalToVideo/
// VideoExtension/VideoEditing, input modalities text+image+video+audio).
const MODEL_25_ID = process.env.NEXT_PUBLIC_SEEDANCE_2_5_MODEL_ID || 'dreamina-seedance-2-5-260628';
const PRIMARY_MODEL_ID = process.env.NEXT_PUBLIC_SEEDANCE_MODEL_ID || 'dreamina-seedance-2-0-260128';
const FAST_MODEL_ID = process.env.NEXT_PUBLIC_SEEDANCE_FAST_MODEL_ID || 'dreamina-seedance-2-0-fast-260128';
const MINI_MODEL_ID = process.env.NEXT_PUBLIC_SEEDANCE_MINI_MODEL_ID || 'dreamina-seedance-2-0-mini-260615';
// Seedance 1.5 Pro — earlier "pro" tier, live-validated id (no dreamina- variant
// exists for 1.5). Open by default alongside Mini.
const PRO15_MODEL_ID = process.env.NEXT_PUBLIC_SEEDANCE_1_5_PRO_MODEL_ID || 'seedance-1-5-pro-251215';

export const MODELS = [
    // Resolution gating per BytePlus ModelArk: only the full Seedance 2.0 model
    // outputs 4k (10-bit HDR); Fast and Mini top out at 720p (no 1080p, no 4k).
    // `gated`: requires an approved access request. `kind`: stable pricing/tier
    // key, immune to model-id rotation via env.
    // Open by default: Seedance 2.0 Mini and Seedance 1.5 Pro. The full and Fast
    // 2.0 tiers require an approved access request (premium models are on permission).
    // `supportsReference`: reference_* content becomes an r2v task at BytePlus,
    // which only the Seedance 2.0 family accepts (1.5 Pro: t2v/i2v/first+last).
    // 2.5 tiers are VERIFIED against the live API by submitting one task per
    // tier, never assumed from the 2.0 family — they originally shipped
    // true-by-analogy and users hit the rejection at submit time, after the
    // request had already been priced, because every check in this app agreed
    // with this list.
    //   2026-08-13  480p/720p accepted · 1080p "not supported for this account
    //               and model" · 4k "not valid for ... in t2v"  -> capped at 720p
    //   2026-08-18  480p/720p/1080p ALL accepted · 4k still rejected
    //               -> 1080p re-enabled
    // The 1080p refusal was ACCOUNT-scoped, as suspected, and lifted on its own
    // (plan/resource-pack change). It can therefore come BACK: if users start
    // seeing "not supported for this account and model" again, re-probe and flip
    // this to false. 4k is a model limit and is not expected to move.
    { id: MODEL_25_ID, name: 'Seedance 2.5', kind: 'full_2_5', gated: true, supports1080p: true, supports4k: false, supportsReference: true, maxDuration: 30 },
    { id: PRIMARY_MODEL_ID, name: 'Seedance 2.0', kind: 'full', gated: true, supports1080p: true, supports4k: true, supportsReference: true },
    { id: FAST_MODEL_ID, name: 'Seedance 2.0 Fast', kind: 'fast', gated: true, supports1080p: false, supports4k: false, supportsReference: true },
    { id: MINI_MODEL_ID, name: 'Seedance 2.0 Mini', kind: 'mini', gated: false, supports1080p: false, supports4k: false, supportsReference: true },
    // ponytail: supports1080p assumed (pro tier, only 720p live-tested); 4k off until confirmed.
    { id: PRO15_MODEL_ID, name: 'Seedance 1.5 Pro', kind: 'pro_1_5', gated: false, supports1080p: true, supports4k: false, supportsReference: false },
];

// Tasks where the output ASPECT RATIO is taken from an input rather than
// chosen. Per the Seedance 2.5 docs, ratio "defaults to and only supports
// adaptive" for:
//   • video editing / extension — follows the video the model selects
//   • first-frame / first-last-frame — follows the first-frame image
// Sending a specific ratio for one of these fails the task, and offering the
// picker is a lie: whatever the user picks is discarded.
//
// Scoped to 2.5, the tier the documented constraints cover. 2.0 also lists edit
// and extend, but its own reference does not state the same restriction and it
// accepts a fixed ratio today — so it is left alone rather than assumed.
//
// A video reference is enough to trigger it: the model decides edit vs
// generate while it renders, so any attached video makes the ratio unownable.
export function ratioIsInherited({ modelId, hasVideoRef = false, hasFirstFrame = false }) {
    const kind = MODELS.find((m) => m.id === modelId)?.kind;
    if (kind !== 'full_2_5') return false;
    return !!(hasVideoRef || hasFirstFrame);
}

export const INHERITED_RATIO = 'adaptive';

// A mode whose media includes reference_* roles is an r2v task — block it on
// models that can't run one (the provider would reject the job after the fact
// with "task_type r2v does not support model …"). Missing mode/model never
// blocks: gating only applies when both sides are known.
export function modeAllowedForModel(mode, model) {
    const needsReference = !!mode?.media?.some((m) => m.role?.startsWith('reference_'));
    return !needsReference || model?.supportsReference !== false;
}

// Ids that require an approved access request. Derived so a future gated model
// is a one-flag change.
export const GATED_MODEL_IDS = MODELS.filter((m) => m.gated).map((m) => m.id);

// Gemini image config (generationConfig.imageConfig). Aspect ratio and the
// imageSize tiers (1K/2K/4K) are accepted by both Nano Banana models — Nano
// Banana Pro (gemini-3-pro-image) fully honours 2K/4K; Nano Banana 2
// (gemini-2.5-flash-image) accepts the field without error but may cap output
// near 1K server-side. We still offer the choice on every model.
export const IMAGE_RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'];
export const IMAGE_RESOLUTIONS = ['1K', '2K', '4K'];

// Image models (Nano Banana / Google Gemini). These run through the gateway's
// batch queue (POST /api/generations), NOT the ModelArk video proxy. `id` MUST
// match the model ids seeded in lib/db/seeds.mjs. `kind` keys image pricing.
// `resolutions`: the imageSize tiers offered for this model.
// Only Nano Banana 2 is open by default; Nano Banana Pro (and Cinematic Studio,
// which runs Pro internally) require an approved access request — same policy as
// the premium video tiers. `gated` drives the picker lock; ids MUST be the model
// aliases seeded in lib/db/seeds.mjs (also the access-request/override key).
export const IMAGE_MODELS = [
    // No 4K on the open model: platform policy makes 4K request-only, and an
    // ungated model has no grant row to cap — so the tier isn't offered at all.
    // (Gemini Flash caps output near 1K server-side regardless, see above.)
    { id: 'nano-banana-2', name: 'Nano Banana 2', kind: 'nano_banana_2', gated: false, resolutions: ['1K', '2K'], maxRefImages: 3 },
    // Nano Banana Pro (Gemini 3 Pro Image) accepts up to 14 reference images in
    // one prompt (docs: 6 high-fidelity object + 5 character refs) — far above the
    // 3-image Flash cap. cloud.google.com/.../ultimate-prompting-guide-for-nano-banana
    { id: 'nano-banana-pro', name: 'Nano Banana Pro', kind: 'nano_banana_pro', gated: true, resolutions: IMAGE_RESOLUTIONS, maxRefImages: 14 },
    // Seedream 5.0 Pro (BytePlus ModelArk). Runs the gateway's byteplus image
    // route (sync images/generations), not the Google batch queue. Its floor is
    // ~2K (min 3.69M px), so 1K isn't offered. References go over as the API's
    // `image` array (10 max for 5.0 Pro) — before that mapping existed the UI
    // still accepted refs at the default cap of 3 and the adapter dropped them.
    { id: 'seedream-5.0-pro', name: 'Seedream 5.0 Pro', kind: 'seedream_pro', gated: true, resolutions: ['2K', '4K'], maxRefImages: 10 },
    // Cinematic Studio is its OWN access-controlled model (its own grant/request,
    // catalog entry, and console row) — not a re-skin of Nano Banana Pro. It runs
    // the same Gemini Pro provider route under the hood (kind → Pro pricing) with
    // the cinematic panel + the enhancer structuring engaged (the imageStudio flag).
    { id: 'cinematic-studio', name: 'Cinematic Studio', kind: 'nano_banana_pro', gated: true, resolutions: IMAGE_RESOLUTIONS, maxRefImages: 14 },
];

// Max reference images accepted per prompt, per image model. Single source of
// truth for the client uploader cap AND the server sanitize clamp. Unknown ids
// (or models without an explicit cap) fall back to the conservative Flash limit.
export const DEFAULT_IMAGE_REF_MAX = 3;
export function imageRefMax(modelId) {
    return IMAGE_MODELS.find((m) => m.id === modelId)?.maxRefImages ?? DEFAULT_IMAGE_REF_MAX;
}

// Image ids behind a request. Kept separate from GATED_MODEL_IDS (video, keyed
// by provider tag) — the image request/override flow keys by the model alias.
export const IMAGE_GATED_MODEL_IDS = IMAGE_MODELS.filter((m) => m.gated).map((m) => m.id);

export const IMAGE_DEFAULT_MODEL_ID = IMAGE_MODELS[0].id;
export const IMAGE_DEFAULTS = { imageRatio: '1:1', imageResolution: '2K' };

// "Cinematic Studio" is a choice in the image model picker AND its own gated
// catalog model — it's access-controlled independently (its own grant/request),
// even though it routes to the same Gemini Pro provider under the hood. Picking
// it engages the Cinematic Cameras panel + the enhancer structuring (the imageStudio
// flag). Picker value === gateway model id === IMAGE_STUDIO_ID.
export const IMAGE_STUDIO_ID = 'cinematic-studio';
export const IMAGE_STUDIO_MODEL_ID = IMAGE_STUDIO_ID;

export const RATIOS = ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];

// Ascending; per-model gating (1080p/4k) is applied where these are offered.
export const RESOLUTIONS = ['480p', '720p', '1080p', '4k'];

// Quality tiers form a ladder: a grant at one tier includes every lower tier
// (4k ⊇ 1080p ⊇ 720p…; 4K ⊇ 2K ⊇ 1K). Case-insensitive so the video ('4k')
// and image ('4K') tokens both resolve. max = null → no cap. Unknown tokens
// (either side) never block here — shape validation lives at the boundary.
export function resolutionWithinTier(requested, max, ladder) {
    if (max == null) return true;
    const idx = (v) => ladder.findIndex((t) => t.toLowerCase() === String(v).toLowerCase());
    const maxIdx = idx(max);
    const reqIdx = idx(requested);
    return maxIdx < 0 || reqIdx < 0 || reqIdx <= maxIdx;
}

// The quality tiers a model can output — what the access-request modal offers
// and what an admin may grant. Video models: the global ladder cut by the
// capability flags; image models: their own `resolutions` list. Unknown → null.
const VIDEO_ALIAS_KIND = {
    'seedance-2.5': 'full_2_5',
    'seedance-2.0': 'full',
    'seedance-2.0-fast': 'fast',
    'seedance-2.0-mini': 'mini',
    'seedance-1.5-pro': 'pro_1_5',
};

export function supportedResolutionsFor(modelId) {
    // Studio requests use provider version tags while the gateway console and
    // database use stable aliases. Resolve both through the model's stable kind.
    const video = MODELS.find((m) => m.id === modelId)
        ?? MODELS.find((m) => m.kind === VIDEO_ALIAS_KIND[modelId]);
    if (video) {
        return RESOLUTIONS.filter((r) => (r !== '1080p' || video.supports1080p) && (r !== '4k' || video.supports4k));
    }
    return IMAGE_MODELS.find((m) => m.id === modelId)?.resolutions ?? null;
}

// Duration is PER MODEL, live-probed per tier on 2026-08-19 — not one global
// range applied to whatever is selected. It used to be exactly that, derived
// from 2.0 and applied to everything, which hid half of what 2.5 can do:
//
//   2.5       30 accepted · 31 "not valid for model dreamina-seedance-2-5 in t2v"
//   2.0       30 rejected  · 15 is the ceiling
//   2.0 Fast  16 rejected
//   2.0 Mini  16 rejected
//   1.5 Pro   16 rejected
//
// -1 means "let the model decide", and is valid on every tier — it is also the
// value Seedance DEMANDS when it classifies a prompt as video editing, since an
// edit inherits the source clip's length (see lib/gateway/videoCreate.mjs).
const DURATION_FLOOR = 4;
const DEFAULT_DURATION_MAX = 15;

export function durationMaxFor(modelId) {
    return MODELS.find((m) => m.id === modelId)?.maxDuration ?? DEFAULT_DURATION_MAX;
}

// The tiers the picker offers for a model: every stop up to its ceiling.
const DURATION_STOPS = [4, 5, 6, 8, 10, 12, 15, 20, 25, 30];
export function durationsFor(modelId) {
    const max = durationMaxFor(modelId);
    return [-1, ...DURATION_STOPS.filter((d) => d >= DURATION_FLOOR && d <= max)];
}

// Kept for callers that predate the per-model split; it is the conservative
// range every model supports, never the maximum any one of them does.
export const DURATIONS = [-1, 4, 5, 6, 8, 10, 12, 15];

export function durationValidFor(modelId, d) {
    if (d === -1) return true;
    return Number.isInteger(d) && d >= DURATION_FLOOR && d <= durationMaxFor(modelId);
}

// The generation modes, in menu order. `media` declares which input slots a
// mode exposes. Roles map to ModelArk's required `role` field per content item.
export const MODES = [
    // The three styled modes run the prompt through the enhancer first
    // (/api/openai/enhance), which restructures it into the strict
    // production brief (locks on performance, audio, camera) the style needs.
    {
        id: 'motion_capture',
        name: 'Motion Capture',
        hint: 'Green-screen source video + reference image(s) — up to 3 videos (15s combined) and 9 images. Video 1 is the primary source of truth; extra videos are secondary reference. Your prompt is auto-structured by the prompt enhancer: performance, audio and camera stay locked; only what you ask for changes.',
        requiresText: true,
        enhanceStyle: 'motion_capture',
        media: [
            { kind: 'video', role: 'reference_video', min: 1, max: 3, label: 'Source video (green screen — first is primary)' },
            { kind: 'image', role: 'reference_image', min: 1, max: 9, label: 'Reference images (environment / clothing / props)' },
        ],
    },
    {
        id: 'green_screen',
        name: 'Green Screen',
        hint: 'Green-screen performance video + target scene. The prompt enhancer restructures your prompt into a strict compositing brief — performance and audio locked, character grounded in the new scene.',
        requiresText: true,
        enhanceStyle: 'green_screen',
        media: [
            { kind: 'video', role: 'reference_video', min: 1, max: 2, label: 'Videos (performance + optional target footage)' },
            { kind: 'image', role: 'reference_image', min: 0, max: 3, label: 'Target scene images' },
        ],
    },
    {
        id: 'performance_transfer',
        name: 'Performance Transfer',
        hint: 'Drive a still photo with a performance video. The face/identity AND the background come from your image; ONLY the acting — body motion, gestures, expressions, lip-sync and audio — is transferred from the video. Auto-structured by the prompt enhancer. (The mirror of Motion Capture, which instead keeps the video’s actor and swaps the scene.)',
        requiresText: true,
        enhanceStyle: 'performance_transfer',
        media: [
            { kind: 'video', role: 'reference_video', min: 1, max: 1, label: 'Performance video (acting + audio source)' },
            { kind: 'image', role: 'reference_image', min: 1, max: 1, label: 'Identity + scene image (face & background)' },
        ],
    },
    {
        id: 't2v',
        name: 'Text → Video',
        hint: 'A prompt is all you need.',
        requiresText: true,
        media: [],
    },
    {
        id: 'i2v_first',
        name: 'Image → Video',
        hint: 'Start from ONE image (the first frame). Want several references? Switch to Multi reference mode.',
        requiresText: false,
        media: [
            { kind: 'image', role: 'first_frame', min: 1, max: 1, label: 'First frame' },
        ],
    },
    {
        id: 'first_last',
        name: 'First + Last frame',
        hint: 'Morph between a start and end image.',
        requiresText: false,
        media: [
            { kind: 'image', role: 'first_frame', min: 1, max: 1, label: 'First frame' },
            { kind: 'image', role: 'last_frame', min: 1, max: 1, label: 'Last frame' },
        ],
    },
    {
        id: 'reference',
        name: 'Multi reference',
        hint: 'Select MANY files at once: up to 9 images, 3 videos, 3 audio. Audio cannot be used alone.',
        requiresText: false,
        media: [
            { kind: 'image', role: 'reference_image', min: 0, max: 9, label: 'Reference images' },
            { kind: 'video', role: 'reference_video', min: 0, max: 3, label: 'Reference videos (URL only)' },
            { kind: 'audio', role: 'reference_audio', min: 0, max: 3, label: 'Reference audio' },
        ],
    },
];

export const DEFAULT_OPTIONS = {
    model: MINI_MODEL_ID,
    ratio: 'adaptive',
    resolution: '720p',
    duration: 5,
    generate_audio: true,
    watermark: false,
    seed: -1,
    // Image-mode only (Gemini imageConfig) — kept under distinct keys so they
    // never collide with the video ratio/resolution above.
    imageRatio: IMAGE_DEFAULTS.imageRatio,
    imageResolution: IMAGE_DEFAULTS.imageResolution,
    imageStudio: false, // true = Cinematic Studio (Nano Banana Pro + cinematic)
};

export const POLL_INTERVAL_MS = 3000;
export const POLL_MAX_ATTEMPTS = 300; // ~15 min ceiling
