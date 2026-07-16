'use client';

// Shared motion primitives for the landing page — the one intentionally
// cinematic surface in the app. The studio itself stays motion-cut per
// design.md; here we use Framer Motion, but keep the system's easing and
// restraint (fade/rise reveals, no scale-bounce).

import { motion, useReducedMotion } from 'framer-motion';

export const EASE = [0.16, 1, 0.3, 1];

// Button voices (design.md component voice), sized up for a marketing page.
export const BTN_PRIMARY =
    'inline-flex items-center gap-2 rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hi';
export const BTN_GHOST =
    'inline-flex items-center gap-2 rounded-md border border-line px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:border-line-strong hover:bg-paper-2';

// Rise-and-fade reveal once the element scrolls into view.
export function Reveal({ children, delay = 0, className }) {
    const reduce = useReducedMotion();
    return (
        <motion.div
            className={className}
            initial={reduce ? false : { opacity: 0, y: 28 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.7, delay, ease: EASE }}
        >
            {children}
        </motion.div>
    );
}

// Section header: uppercase eyebrow + display title + optional lede.
export function SectionHead({ eyebrow, title, lede }) {
    return (
        <Reveal className="mx-auto max-w-2xl text-center">
            <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.18em] text-ink-3">
                <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" />
                {eyebrow}
            </p>
            <h2 className="font-display text-3xl font-semibold tracking-tight md:text-4xl">{title}</h2>
            {lede ? <p className="mt-3 text-[15px] leading-relaxed text-ink-2">{lede}</p> : null}
        </Reveal>
    );
}
