import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

/** @type {import('next').NextConfig} */
export default function nextConfig(phase) {
  return {
    // Production builds and the dev compiler produce incompatible chunk
    // graphs. Keeping them separate prevents a build/restart from leaving the
    // browser (and Clerk's lazy UI renderer) pointing at stale vendor chunks.
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next',
    transpilePackages: ['studio', 'ai-agent', 'workflow-builder', 'design-agent'],
  };
}
