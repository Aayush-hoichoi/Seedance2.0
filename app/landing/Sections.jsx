'use client';

// Below-the-fold landing sections: model marquee, feature grid, how-it-works,
// closing call-to-action and footer. Motion = scroll reveals + one infinite
// marquee, all skipped under prefers-reduced-motion.

import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import {
    ArrowRight,
    Clapperboard,
    Film,
    FolderKanban,
    GalleryHorizontalEnd,
    Image as ImageIcon,
    Layers,
} from 'lucide-react';
import { BTN_GHOST, BTN_PRIMARY, Reveal, SectionHead } from './motion.jsx';

const MODELS = [
    'Seedance 2.0',
    'Seedance 2.0 Fast',
    'Seedance 2.0 Mini',
    'Seedance 1.5 Pro',
    'Nano Banana 2',
    'Nano Banana Pro',
    'Seedream 5.0 Pro',
];

const FEATURES = [
    {
        icon: Clapperboard,
        title: 'Text to video',
        body: 'Direct full scenes from a single prompt — camera moves, lighting, tone — with batch takes to pick the keeper from.',
    },
    {
        icon: Film,
        title: 'Reference to video',
        body: 'Cast a face, a product or a style: drop reference stills and clips, and Seedance 2.0 keeps them consistent shot to shot.',
    },
    {
        icon: Layers,
        title: 'First & last frame',
        body: 'Pin the opening and closing frame of a shot and let the model fill the motion in between.',
    },
    {
        icon: ImageIcon,
        title: 'Image generation',
        body: 'Nano Banana and Seedream models for stills, boards and key art — generated right beside your video takes.',
    },
    {
        icon: FolderKanban,
        title: 'Projects & budgets',
        body: 'Every generation lives in a project with its own members, model access and spend tracking. No stray costs.',
    },
    {
        icon: GalleryHorizontalEnd,
        title: 'Team gallery',
        body: "Publish the best takes to a shared gallery — like, reuse prompts and build on each other's shots.",
    },
];

const STEPS = [
    {
        title: 'Join a project',
        body: "Sign in and land in your team's workspace. Admins control membership, model access and budgets.",
    },
    {
        title: 'Prompt the take',
        body: 'Write the shot, attach reference images or clips, pick a model and a batch size — then roll.',
    },
    {
        title: 'Review & reuse',
        body: 'Takes land in your queue as they finish. Publish keepers to the gallery and remix any prompt.',
    },
];

export function ModelMarquee() {
    const reduce = useReducedMotion();
    const row = MODELS.map((m) => (
        <span key={m} className="inline-flex items-center gap-10">
            <span>{m}</span>
            <span className="text-accent/60">·</span>
        </span>
    ));
    return (
        <div className="overflow-hidden border-y border-line/70 bg-paper-1/50 py-4">
            <motion.div
                className="flex w-max gap-10 whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.22em] text-ink-3"
                animate={reduce ? undefined : { x: ['0%', '-50%'] }}
                transition={{ duration: 36, ease: 'linear', repeat: Infinity }}
            >
                <span className="flex items-center gap-10">{row}</span>
                <span aria-hidden className="flex items-center gap-10">{row}</span>
            </motion.div>
        </div>
    );
}

export function Features() {
    return (
        <section id="features" className="mx-auto max-w-6xl px-5 py-24 md:py-32">
            <SectionHead
                eyebrow="What's inside"
                title="One studio for every shot"
                lede="Frontier video and image models behind one prompt bar, with the team plumbing — access, budgets, review — already built in."
            />
            <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {FEATURES.map((f, i) => (
                    <Reveal key={f.title} delay={(i % 3) * 0.07}>
                        <div className="group h-full rounded-lg border border-line bg-paper-2 p-6 transition-colors hover:border-line-strong hover:bg-paper-3">
                            <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-md border border-line bg-paper-1 text-accent transition-colors group-hover:border-line-strong">
                                <f.icon size={18} />
                            </div>
                            <h3 className="font-display text-lg font-semibold tracking-tight">{f.title}</h3>
                            <p className="mt-2 text-sm leading-relaxed text-ink-2">{f.body}</p>
                        </div>
                    </Reveal>
                ))}
            </div>
        </section>
    );
}

export function HowItWorks() {
    return (
        <section id="how-it-works" className="border-t border-line/70 bg-paper-1/40">
            <div className="mx-auto max-w-6xl px-5 py-24 md:py-32">
                <SectionHead
                    eyebrow="How it works"
                    title="Three steps to a finished take"
                />
                <div className="mt-14 grid gap-4 md:grid-cols-3">
                    {STEPS.map((s, i) => (
                        <Reveal key={s.title} delay={i * 0.09}>
                            <div className="h-full rounded-lg border border-line bg-paper-2 p-6">
                                <p className="font-mono text-3xl font-medium tabular-nums text-accent">
                                    {String(i + 1).padStart(2, '0')}
                                </p>
                                <h3 className="mt-4 font-display text-lg font-semibold tracking-tight">{s.title}</h3>
                                <p className="mt-2 text-sm leading-relaxed text-ink-2">{s.body}</p>
                            </div>
                        </Reveal>
                    ))}
                </div>
            </div>
        </section>
    );
}

export function ClosingCta() {
    return (
        <section className="relative overflow-hidden border-t border-line/70">
            <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{ background: 'radial-gradient(50rem 30rem at 50% 120%, rgb(139 124 246 / 0.14), transparent 70%)' }}
            />
            <div className="relative mx-auto max-w-3xl px-5 py-28 text-center md:py-36">
                <Reveal>
                    <h2 className="font-display text-4xl font-semibold tracking-tight md:text-5xl">Ready to roll camera?</h2>
                    <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-ink-2">
                        Create an account, ask your admin to add you to a project, and your first take is a prompt away.
                    </p>
                    <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                        <Link href="/sign-up" className={BTN_PRIMARY}>
                            Create your account <ArrowRight size={16} />
                        </Link>
                        <Link href="/sign-in" className={BTN_GHOST}>
                            Sign in
                        </Link>
                    </div>
                </Reveal>
            </div>
        </section>
    );
}

export function Footer() {
    return (
        <footer className="border-t border-line/70">
            <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-5 py-8 sm:flex-row">
                <p className="font-display text-sm font-semibold tracking-tight">
                    logline<span className="text-accent">AI</span> Studio
                </p>
                <p className="text-xs text-ink-3">© {new Date().getFullYear()} loglineAI Studio. Internal creative tooling.</p>
            </div>
        </footer>
    );
}
