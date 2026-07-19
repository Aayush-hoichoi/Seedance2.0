'use client';

// Landing splash for the projects hub — splash FIRST, page after: a solid
// overlay covers the page from first paint, shows a funny greeting with the
// user's name plus a dad joke from icanhazdadjoke.com (free, no key, CORS-
// open; local fallbacks when slow/down), then dissolves to reveal the page.
// Plays on EVERY reload with a fresh line each time; click anywhere skips.
// Animation: motion (framer-motion's successor).

import { useEffect, useRef, useState } from 'react';
import { useUser } from '@clerk/nextjs';
import { motion, AnimatePresence } from 'motion/react';

const HELLOS = [
    'Look who’s back — {name}!',
    'Ah, {name}. The render farm missed you.',
    '{name} has entered the studio 🎬',
    'Rolling out the red carpet for {name}…',
    'Quiet on set — {name} is here.',
    'Action! {name} is on the clock.',
];

const FALLBACK_JOKES = [
    'Why don’t film crews play hide and seek? Good luck hiding from the director’s cut.',
    'I told my video to be more positive. Now it only renders in HDR.',
    'The AI asked for a day off — said it was feeling a bit overexposed.',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export default function WelcomeSplash() {
    const { user, isLoaded } = useUser();
    const [show, setShow] = useState(true); // overlay is up from first paint
    const [hello, setHello] = useState('');
    const [joke, setJoke] = useState('');
    // Hovering the text = reading: the auto-hide defers until the cursor leaves.
    const hovering = useRef(false);
    const pendingHide = useRef(false);
    const tryHide = () => {
        if (hovering.current) { pendingHide.current = true; return; }
        setShow(false);
    };

    // Greeting as soon as Clerk resolves the user (usually instant from cache).
    useEffect(() => {
        if (!isLoaded) return;
        const name = user?.firstName || user?.username
            || user?.primaryEmailAddress?.emailAddress?.split('@')[0] || 'there';
        setHello(pick(HELLOS).replace('{name}', name));
    }, [isLoaded, user]);

    // Punchline (≤1.2s), then hold and dissolve to reveal the page.
    useEffect(() => {
        let cancelled = false;
        let hideTimer;
        const ctrl = new AbortController();
        const kill = setTimeout(() => ctrl.abort(), 1200);
        fetch('https://icanhazdadjoke.com/', { headers: { Accept: 'application/json' }, signal: ctrl.signal })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
            .then((d) => {
                clearTimeout(kill);
                if (cancelled) return;
                setJoke(d?.joke || pick(FALLBACK_JOKES));
                hideTimer = setTimeout(tryHide, 5500); // enough time to actually read the joke
            });
        return () => { cancelled = true; clearTimeout(kill); clearTimeout(hideTimer); ctrl.abort(); };
    }, []);

    return (
        <AnimatePresence>
            {show && (
                <motion.div
                    key="welcome"
                    initial={false}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, transition: { duration: 0.55, ease: 'easeInOut' } }}
                    onClick={() => setShow(false)}
                    className="fixed inset-0 z-[80] grid cursor-pointer place-items-center bg-app-bg"
                    aria-live="polite"
                >
                    <div
                        className="px-6 text-center"
                        onMouseEnter={() => { hovering.current = true; }}
                        onMouseLeave={() => {
                            hovering.current = false;
                            // Deferred while reading — dismiss shortly after the cursor leaves.
                            if (pendingHide.current) setTimeout(() => { if (!hovering.current) setShow(false); }, 700);
                        }}
                    >
                        {hello && (
                            <motion.h1
                                initial={{ opacity: 0, y: 28, scale: 0.94, filter: 'blur(12px)' }}
                                animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
                                exit={{ opacity: 0, y: -18, filter: 'blur(8px)' }}
                                transition={{ type: 'spring', stiffness: 160, damping: 19 }}
                                className="font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl"
                            >
                                {hello}
                            </motion.h1>
                        )}
                        {joke && (
                            <motion.p
                                initial={{ opacity: 0, y: 16 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0 }}
                                transition={{ delay: 0.15, duration: 0.5, ease: 'easeOut' }}
                                className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-ink-2"
                            >
                                {joke}
                            </motion.p>
                        )}
                        <motion.span
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ delay: 1.4, duration: 0.6 }}
                            className="mt-6 inline-block text-[11px] uppercase tracking-[0.16em] text-ink-3"
                        >
                            click anywhere to continue
                        </motion.span>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
