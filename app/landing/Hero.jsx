'use client';

// Landing hero: three.js aurora behind a staggered headline, with a gentle
// scroll parallax on the copy as the section leaves the viewport.

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRef } from 'react';
import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion';
import { ArrowRight, ChevronDown } from 'lucide-react';
import { BTN_GHOST, BTN_PRIMARY, EASE } from './motion.jsx';

const HeroCanvas = dynamic(() => import('./HeroCanvas.jsx'), { ssr: false });

const stagger = {
    hidden: {},
    show: { transition: { staggerChildren: 0.09, delayChildren: 0.15 } },
};
const rise = {
    hidden: { opacity: 0, y: 26 },
    show: { opacity: 1, y: 0, transition: { duration: 0.8, ease: EASE } },
};

export default function Hero() {
    const reduce = useReducedMotion();
    const sectionRef = useRef(null);
    const { scrollYProgress } = useScroll({ target: sectionRef, offset: ['start start', 'end start'] });
    const copyY = useTransform(scrollYProgress, [0, 1], [0, 110]);
    const copyOpacity = useTransform(scrollYProgress, [0, 0.7], [1, 0]);

    return (
        <section ref={sectionRef} className="relative flex min-h-[100svh] flex-col items-center justify-center overflow-hidden px-5">
            {/* CSS wash — also the fallback frame when WebGL is unavailable */}
            <div
                aria-hidden
                className="absolute inset-0"
                style={{ background: 'radial-gradient(70rem 48rem at 50% -12%, rgb(139 124 246 / 0.16), transparent 70%)' }}
            />
            <HeroCanvas />
            {/* settle the canvas into the page ground */}
            <div aria-hidden className="absolute inset-x-0 bottom-0 h-44 bg-gradient-to-b from-transparent to-app-bg" />

            <motion.div
                style={reduce ? undefined : { y: copyY, opacity: copyOpacity }}
                className="relative z-10 mx-auto max-w-4xl pt-14 text-center"
            >
                <motion.div variants={stagger} initial={reduce ? false : 'hidden'} animate="show">
                    <motion.p
                        variants={rise}
                        className="mb-5 inline-flex items-center gap-2 rounded-full border border-line/80 bg-paper-1/70 px-3.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-ink-2"
                    >
                        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                        AI video &amp; image studio
                    </motion.p>

                    <motion.h1
                        variants={rise}
                        className="font-display text-[2.75rem] font-semibold leading-[1.05] tracking-tight md:text-7xl"
                    >
                        From logline to <span className="text-accent">screen</span>.
                    </motion.h1>

                    <motion.p variants={rise} className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-ink-2 md:text-lg">
                        Generate cinema-grade video and imagery with Seedance 2.0, Nano Banana and more —
                        organised by project, budgeted per team, reviewed in one shared gallery.
                    </motion.p>

                    <motion.div variants={rise} className="mt-9 flex flex-wrap items-center justify-center gap-3">
                        <Link href="/sign-up" className={BTN_PRIMARY}>
                            Create your account <ArrowRight size={16} />
                        </Link>
                        <Link href="/sign-in" className={BTN_GHOST}>
                            Sign in
                        </Link>
                    </motion.div>

                    <motion.p variants={rise} className="mt-9 font-mono text-[11px] uppercase tracking-[0.2em] text-ink-3">
                        Seedance 2.0 · Nano Banana 2 · Seedream 5.0
                    </motion.p>
                </motion.div>
            </motion.div>

            <motion.div
                aria-hidden
                className="absolute bottom-7 z-10 text-ink-3"
                animate={reduce ? undefined : { y: [0, 7, 0] }}
                transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
            >
                <ChevronDown size={18} />
            </motion.div>
        </section>
    );
}
