import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

/** @type {import('next').NextConfig} */
export default function nextConfig(phase) {
  return {
    // Production builds and the dev compiler produce incompatible chunk
    // graphs. Keeping them separate prevents a build/restart from leaving the
    // browser (and Clerk's lazy UI renderer) pointing at stale vendor chunks.
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next',
    transpilePackages: ['studio', 'ai-agent', 'workflow-builder', 'design-agent'],
    // ffmpeg-static finds its binary via __dirname, which webpack rewrites to the
    // route's .next dir, and the tracer can't see the binary (its name comes from
    // package.json). Without both lines the download route's H.265 → H.264 fix
    // silently no-ops and HEVC files reach the user untouched.
    serverExternalPackages: ['ffmpeg-static'],
    outputFileTracingIncludes: {
      '/api/seedance/download': ['./node_modules/ffmpeg-static/ffmpeg'],
    },
  };
}
