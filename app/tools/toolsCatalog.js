// The tool catalog, shared by the /tools page and the studio header's
// hover dropdown so the two lists can never drift apart.

import { Columns2, Layers, Maximize2 } from 'lucide-react';

export const TOOLS = [
    { id: 'upscale', name: 'Upscale Video', blurb: 'AI super-resolution up to 8K with frame interpolation, denoise, and pro codecs (H.265, ProRes, FFV1).', icon: Maximize2, href: '/tools/upscale' },
    { id: 'exr', name: 'EXR Output', blurb: 'Lossless 16-bit 4:4:4 master (FFV1 MOV) for VFX and grading pipelines.', icon: Layers, href: '/tools/exr' },
    { id: 'compare', name: 'Compare Video', blurb: 'Play 2 or 4 takes in a grid, in sync — upload files or pick studio generations.', icon: Columns2, href: '/tools/compare' },
];
