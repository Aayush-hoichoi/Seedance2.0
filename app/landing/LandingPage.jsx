'use client';

// Public landing page for loglineAI Studio. Rendered only for signed-out
// visitors (app/page.js redirects authenticated users to /projects).
// Lenis drives document scrolling for the whole page; it is skipped under
// prefers-reduced-motion.

import Link from 'next/link';
import { useEffect } from 'react';
import Lenis from 'lenis';
import Hero from './Hero.jsx';
import { ClosingCta, Features, Footer, HowItWorks, ModelMarquee } from './Sections.jsx';
import { BTN_GHOST, BTN_PRIMARY } from './motion.jsx';

export default function LandingPage() {
    useEffect(() => {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
        const lenis = new Lenis({ lerp: 0.1 });
        let raf = requestAnimationFrame(function loop(time) {
            lenis.raf(time);
            raf = requestAnimationFrame(loop);
        });
        return () => {
            cancelAnimationFrame(raf);
            lenis.destroy();
        };
    }, []);

    return (
        <div className="bg-app-bg text-ink">
            <header className="fixed inset-x-0 top-0 z-40 border-b border-line/60 bg-app-bg/85 backdrop-blur-md">
                <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
                    <Link href="/" className="font-display text-[15px] font-semibold tracking-tight">
                        logline<span className="text-accent">AI</span> Studio
                    </Link>
                    <div className="hidden items-center gap-6 text-sm text-ink-2 md:flex">
                        <a href="#features" className="transition-colors hover:text-ink">Features</a>
                        <a href="#how-it-works" className="transition-colors hover:text-ink">How it works</a>
                    </div>
                    <div className="flex items-center gap-2.5">
                        <Link href="/sign-in" className={`${BTN_GHOST} !px-4 !py-2`}>
                            Sign in
                        </Link>
                        <Link href="/sign-up" className={`${BTN_PRIMARY} !px-4 !py-2`}>
                            Get started
                        </Link>
                    </div>
                </nav>
            </header>

            <main>
                <Hero />
                <ModelMarquee />
                <Features />
                <HowItWorks />
                <ClosingCta />
            </main>
            <Footer />
        </div>
    );
}
