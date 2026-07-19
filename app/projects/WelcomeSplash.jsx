'use client';

// One-shot landing splash for the projects hub: a funny greeting with the
// user's name, punchlined by a dad joke from icanhazdadjoke.com (free, no
// key, CORS-open; local fallbacks when it's slow or down). Reveals with a
// spring + blur, holds, then dissolves — once per browser session, and a
// click anywhere skips it. Animation: motion (framer-motion's successor).

import { useEffect, useState } from 'react';
import { useUser } from '@clerk/nextjs';
import { motion, AnimatePresence } from 'motion/react';

const SEEN_KEY = 'll_welcome_seen';

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
    const [show, setShow] = useState(false);
    const [hello, setHello] = useState('');
    const [joke, setJoke] = useState('');

    useEffect(() => {
        if (!isLoaded || !user) return undefined;
        try {
            if (sessionStorage.getItem(SEEN_KEY)) return undefined;
            sessionStorage.setItem(SEEN_KEY, '1');
        } catch { return undefined; }

        const name = user.firstName || user.username
            || user.primaryEmailAddress?.emailAddress?.split('@')[0] || 'there';
        setHello(pick(HELLOS).replace('{name}', name));

        // Grab the punchline first (≤1.2s), then reveal — no mid-read text swap.
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
                setShow(true);
                hideTimer = setTimeout(() => setShow(false), 3600);
            });
        return () => { cancelled = true; clearTimeout(kill); clearTimeout(hideTimer); ctrl.abort(); };
    }, [isLoaded, user]);

    return (
        <AnimatePresence>
            {show && (
                <motion.div
                    key="welcome"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, transition: { duration: 0.45, ease: 'easeInOut' } }}
                    onClick={() => setShow(false)}
                    className="fixed inset-0 z-[80] grid cursor-pointer place-items-center bg-app-bg/85 backdrop-blur-md"
                    aria-live="polite"
                >
                    <div className="px-6 text-center">
                        <motion.h1
                            initial={{ opacity: 0, y: 28, scale: 0.94, filter: 'blur(12px)' }}
                            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
                            exit={{ opacity: 0, y: -18, filter: 'blur(8px)' }}
                            transition={{ type: 'spring', stiffness: 160, damping: 19 }}
                            className="font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl"
                        >
                            {hello}
                        </motion.h1>
                        <motion.p
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            transition={{ delay: 0.4, duration: 0.5, ease: 'easeOut' }}
                            className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-ink-2"
                        >
                            {joke}
                        </motion.p>
                        <motion.span
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ delay: 1.2, duration: 0.6 }}
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
