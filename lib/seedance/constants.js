// BytePlus ModelArk Seedance 2.0 — option catalog and mode definitions.
// Model IDs carry a date suffix and can be deprecated/rotated by BytePlus.
// When that happens, override via .env.local WITHOUT a code edit:
//   NEXT_PUBLIC_SEEDANCE_MODEL_ID=dreamina-seedance-2-0-<newdate>   (or an ep-xxxx endpoint)
//   NEXT_PUBLIC_SEEDANCE_FAST_MODEL_ID=dreamina-seedance-2-0-fast-<newdate>
// The hardcoded values below are the known-good defaults used when the env vars are unset.

const PRIMARY_MODEL_ID = process.env.NEXT_PUBLIC_SEEDANCE_MODEL_ID || 'dreamina-seedance-2-0-260128';
const FAST_MODEL_ID = process.env.NEXT_PUBLIC_SEEDANCE_FAST_MODEL_ID || 'dreamina-seedance-2-0-fast-260128';

export const MODELS = [
    { id: PRIMARY_MODEL_ID, name: 'Seedance 2.0', supports1080p: true },
    { id: FAST_MODEL_ID, name: 'Seedance 2.0 Fast', supports1080p: false },
];

export const RATIOS = ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];

export const RESOLUTIONS = ['480p', '720p', '1080p'];

// Seedance 2.0 supports integer [4,15], or -1 for the model to auto-pick.
export const DURATIONS = [-1, 4, 5, 6, 8, 10, 12, 15];

// The four generation modes. `media` declares which input slots a mode exposes.
// Roles map to ModelArk's required `role` field per content item.
export const MODES = [
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
    model: MODELS[0].id,
    ratio: 'adaptive',
    resolution: '720p',
    duration: 5,
    generate_audio: true,
    watermark: false,
    seed: -1,
};

export const POLL_INTERVAL_MS = 3000;
export const POLL_MAX_ATTEMPTS = 300; // ~15 min ceiling
