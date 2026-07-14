// BytePlus ModelArk Seedance 2.0 — option catalog and mode definitions.
// Model IDs carry a date suffix and can be deprecated/rotated by BytePlus.
// When that happens, override via .env.local WITHOUT a code edit:
//   NEXT_PUBLIC_SEEDANCE_MODEL_ID=dreamina-seedance-2-0-<newdate>   (or an ep-xxxx endpoint)
//   NEXT_PUBLIC_SEEDANCE_FAST_MODEL_ID=dreamina-seedance-2-0-fast-<newdate>
//   NEXT_PUBLIC_SEEDANCE_MINI_MODEL_ID=dreamina-seedance-2-0-mini-<newdate>
// The hardcoded values below are the known-good defaults used when the env vars are unset.

const PRIMARY_MODEL_ID = process.env.NEXT_PUBLIC_SEEDANCE_MODEL_ID || 'dreamina-seedance-2-0-260128';
const FAST_MODEL_ID = process.env.NEXT_PUBLIC_SEEDANCE_FAST_MODEL_ID || 'dreamina-seedance-2-0-fast-260128';
const MINI_MODEL_ID = process.env.NEXT_PUBLIC_SEEDANCE_MINI_MODEL_ID || 'dreamina-seedance-2-0-mini-260615';

export const MODELS = [
    // Resolution gating per BytePlus ModelArk: only the full Seedance 2.0 model
    // outputs 4k (10-bit HDR); Fast and Mini top out at 720p (no 1080p, no 4k).
    // `gated`: requires an approved access request (full 2.0 only). `kind`: stable
    // pricing/tier key, immune to model-id rotation via env.
    { id: PRIMARY_MODEL_ID, name: 'Seedance 2.0', kind: 'full', gated: true, supports1080p: true, supports4k: true },
    { id: FAST_MODEL_ID, name: 'Seedance 2.0 Fast', kind: 'fast', gated: false, supports1080p: false, supports4k: false },
    { id: MINI_MODEL_ID, name: 'Seedance 2.0 Mini', kind: 'mini', gated: false, supports1080p: false, supports4k: false },
];

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
export const IMAGE_MODELS = [
    { id: 'nano-banana-2', name: 'Nano Banana 2', kind: 'nano_banana_2', resolutions: IMAGE_RESOLUTIONS },
    { id: 'nano-banana-pro', name: 'Nano Banana Pro', kind: 'nano_banana_pro', resolutions: IMAGE_RESOLUTIONS },
];

export const IMAGE_DEFAULT_MODEL_ID = IMAGE_MODELS[0].id;
export const IMAGE_DEFAULTS = { imageRatio: '1:1', imageResolution: '2K' };

// "Cinematic Studio" is a third choice in the image model picker. It is not a
// model — it runs on Nano Banana Pro internally (no separate model selection)
// with the Cinematic Cameras panel + GPT-4o prompt structuring always engaged.
// The picker value is IMAGE_STUDIO_ID; the real model sent is IMAGE_STUDIO_MODEL_ID.
export const IMAGE_STUDIO_ID = 'cinematic-studio';
export const IMAGE_STUDIO_MODEL_ID = 'nano-banana-pro';

export const RATIOS = ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];

// Ascending; per-model gating (1080p/4k) is applied where these are offered.
export const RESOLUTIONS = ['480p', '720p', '1080p', '4k'];

// Seedance 2.0 supports integer [4,15], or -1 for the model to auto-pick.
export const DURATIONS = [-1, 4, 5, 6, 8, 10, 12, 15];

// The generation modes, in menu order. `media` declares which input slots a
// mode exposes. Roles map to ModelArk's required `role` field per content item.
export const MODES = [
    // The three styled modes run the prompt through GPT-4o first
    // (/api/openai/enhance), which restructures it into the strict
    // production brief (locks on performance, audio, camera) the style needs.
    {
        id: 'motion_capture',
        name: 'Motion Capture',
        hint: 'Green-screen source video + reference image(s). Your prompt is auto-structured by GPT-4o: performance, audio and camera stay locked; only what you ask for changes.',
        requiresText: true,
        enhanceStyle: 'motion_capture',
        media: [
            { kind: 'video', role: 'reference_video', min: 1, max: 1, label: 'Source video (green screen)' },
            { kind: 'image', role: 'reference_image', min: 1, max: 3, label: 'Reference images (environment / clothing / props)' },
        ],
    },
    {
        id: 'green_screen',
        name: 'Green Screen',
        hint: 'Green-screen performance video + target scene. GPT-4o restructures your prompt into a strict compositing brief — performance and audio locked, character grounded in the new scene.',
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
        hint: 'Drive a still photo with a performance video. The face/identity AND the background come from your image; ONLY the acting — body motion, gestures, expressions, lip-sync and audio — is transferred from the video. Auto-structured by GPT-4o. (The mirror of Motion Capture, which instead keeps the video’s actor and swaps the scene.)',
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
